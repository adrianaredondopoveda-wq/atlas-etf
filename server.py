#!/usr/bin/env python3
"""Atlas ETF local server backed by public BME and international quotes."""

from __future__ import annotations

import json
import mimetypes
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", os.environ.get("ATLAS_PORT", "4173")))
HOST = os.environ.get("ATLAS_HOST", "127.0.0.1")
POLL_SECONDS = max(float(os.environ.get("ATLAS_POLL_SECONDS", "60")), 30.0)
BME_API = "https://apiweb.bolsasymercados.es/Market/v1/ETF/ETFSessionSummary"
BME_SOURCE = "https://www.bolsasymercados.es/es/bme-exchange/mercados-y-cotizaciones/etfs/precios.html"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_SOURCE = "https://finance.yahoo.com/"
ECB_FX = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
UNIVERSE = json.loads((ROOT / "universe.json").read_text(encoding="utf-8"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bme_is_open() -> bool:
    now = datetime.now().astimezone()
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return 9 * 60 <= minutes < 17 * 60 + 35


def market_is_open(timezone_name: str, open_time: tuple[int, int], close_time: tuple[int, int]) -> bool:
    now = datetime.now(ZoneInfo(timezone_name))
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return open_time[0] * 60 + open_time[1] <= minutes < close_time[0] * 60 + close_time[1]


def native_to_eur(value: float | None, currency: str, rates: dict[str, float]) -> float | None:
    if value is None:
        return None
    if currency == "EUR":
        return value
    if currency == "GBp":
        gbp_rate = rates.get("GBP")
        return value / 100 / gbp_rate if gbp_rate else None
    rate = rates.get(currency)
    return value / rate if rate else None


class EcbFxProvider:
    def __init__(self) -> None:
        self._cached_at = 0.0
        self._rates: dict[str, float] = {"EUR": 1.0}
        self._date = ""

    def rates(self) -> tuple[dict[str, float], str]:
        now = time.time()
        if len(self._rates) > 1 and now - self._cached_at < 6 * 60 * 60:
            return self._rates, self._date
        request = urllib.request.Request(ECB_FX, headers={"User-Agent": "AtlasETF/0.4"})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                root = ET.fromstring(response.read())
            rates = {"EUR": 1.0}
            fx_date = ""
            for node in root.iter():
                if "time" in node.attrib:
                    fx_date = node.attrib["time"]
                if "currency" in node.attrib and "rate" in node.attrib:
                    rates[node.attrib["currency"]] = float(node.attrib["rate"])
            if len(rates) <= 1:
                raise RuntimeError("el BCE no devolvió tipos de cambio")
            self._rates, self._date, self._cached_at = rates, fx_date, now
        except Exception:
            if len(self._rates) <= 1:
                raise
        return self._rates, self._date


class BmeProvider:
    name = "BME público"

    def __init__(self) -> None:
        self._cached_at = 0.0
        self._cached_payload: dict[str, Any] | None = None

    @staticmethod
    def _get(date_value: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"date": date_value, "page": 0, "pageSize": 0})
        request = urllib.request.Request(
            f"{BME_API}?{query}",
            headers={
                "Accept": "application/json",
                "Origin": "https://www.bolsasymercados.es",
                "Referer": BME_SOURCE,
                "User-Agent": "AtlasETF/0.3",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"BME respondió {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError("No se puede conectar con el endpoint público de BME") from exc

    def _latest_session(self) -> dict[str, Any]:
        now = time.time()
        if self._cached_payload and now - self._cached_at < POLL_SECONDS:
            return self._cached_payload

        local_date = datetime.now().astimezone().date()
        for days_back in range(8):
            candidate = (local_date - timedelta(days=days_back)).strftime("%Y%m%d")
            payload = self._get(candidate)
            if payload.get("data"):
                self._cached_payload = payload
                self._cached_at = now
                return payload
        raise RuntimeError("BME no devolvió ninguna sesión de ETF durante los últimos ocho días")

    def quotes(self, fund_id: str = "all") -> dict[str, Any]:
        payload = self._latest_session()
        metadata = {fund["isin"]: fund for fund in UNIVERSE["funds"]}
        rows = []
        first_row = payload.get("data", [{}])[0]
        session_date = first_row.get("date") or payload.get("params", {}).get("date", "")
        today = datetime.now().astimezone().strftime("%Y%m%d")
        market_state = "open" if session_date == today and bme_is_open() else "closed"

        for row in payload.get("data", []):
            fund = metadata.get(row.get("isin"))
            if not fund or (fund_id != "all" and fund["id"] != fund_id):
                continue
            close = float(row.get("close") or 0)
            previous = float(row.get("prev") or 0)
            change_percent = ((close - previous) / previous * 100) if close and previous else None
            nav = float(row.get("nav") or 0) or None
            nav_premium = ((close - nav) / nav * 100) if close and nav else None
            listing = next(item for item in fund["listings"] if item.get("provider") == "bme")
            rows.append(
                {
                    **listing,
                    "fundId": fund["id"],
                    "isin": fund["isin"],
                    "name": row.get("name") or fund["name"],
                    "index": fund["index"],
                    "last": close or None,
                    "nativeLast": close or None,
                    "eurLast": close or None,
                    "currency": "EUR",
                    "previous": previous or None,
                    "changePercent": change_percent,
                    "high": float(row.get("high") or 0) or None,
                    "low": float(row.get("low") or 0) or None,
                    "eurHigh": float(row.get("high") or 0) or None,
                    "eurLow": float(row.get("low") or 0) or None,
                    "volume": int(row.get("volume") or 0),
                    "turnover": float(row.get("turnover") or 0),
                    "nav": nav,
                    "navPremiumPercent": nav_premium,
                    "date": row.get("date") or session_date,
                    "state": market_state,
                    "delay": "BME | 15 min",
                    "sourceLabel": "BME oficial",
                    "sourceUrl": BME_SOURCE,
                    "official": True,
                    "quoteTimestamp": None,
                }
            )

        return {
            "provider": self.name,
            "providerCode": "bme-public",
            "quality": "delayed",
            "delayMinutes": 15,
            "timestamp": utc_now(),
            "sessionDate": session_date,
            "source": BME_SOURCE,
            "quotes": rows,
        }


class YahooProvider:
    name = "Yahoo Finance público"

    MARKET_HOURS = {
        "LSE": ("Europe/London", (8, 0), (16, 30)),
        "XETRA": ("Europe/Berlin", (9, 0), (17, 30)),
        "Milan": ("Europe/Rome", (9, 0), (17, 30)),
        "Amsterdam": ("Europe/Amsterdam", (9, 0), (17, 30)),
        "Swiss": ("Europe/Zurich", (9, 0), (17, 30)),
    }

    def __init__(self) -> None:
        self._cached_at = 0.0
        self._cached_rows: list[dict[str, Any]] = []
        self._cached_warnings: list[str] = []

    @staticmethod
    def _get_listing(fund: dict[str, Any], listing: dict[str, Any], rates: dict[str, float]) -> dict[str, Any]:
        symbol = urllib.parse.quote(listing["ticker"], safe="")
        query = urllib.parse.urlencode({"interval": "1m", "range": "1d"})
        request = urllib.request.Request(
            f"{YAHOO_CHART.format(symbol=symbol)}?{query}",
            headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 AtlasETF/0.4"},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
        result = payload.get("chart", {}).get("result") or []
        if not result:
            raise RuntimeError(payload.get("chart", {}).get("error", {}).get("description") or "sin cotización")
        meta = result[0].get("meta", {})
        currency = meta.get("currency") or listing["currency"]
        last = float(meta["regularMarketPrice"]) if meta.get("regularMarketPrice") is not None else None
        previous = float(meta["chartPreviousClose"]) if meta.get("chartPreviousClose") is not None else None
        high = float(meta["regularMarketDayHigh"]) if meta.get("regularMarketDayHigh") is not None else None
        low = float(meta["regularMarketDayLow"]) if meta.get("regularMarketDayLow") is not None else None
        volume = int(meta.get("regularMarketVolume") or 0)
        change_percent = ((last - previous) / previous * 100) if last is not None and previous else None
        quote_epoch = int(meta.get("regularMarketTime") or 0)
        timezone_name = meta.get("exchangeTimezoneName") or "UTC"
        quote_time = datetime.fromtimestamp(quote_epoch, timezone.utc) if quote_epoch else None
        quote_local = quote_time.astimezone(ZoneInfo(timezone_name)) if quote_time else None
        full_exchange = meta.get("fullExchangeName") or meta.get("exchangeName") or listing["exchange"]
        hours = YahooProvider.MARKET_HOURS.get(full_exchange)
        is_open = market_is_open(*hours) if hours else False
        eur_last = native_to_eur(last, currency, rates)
        eur_high = native_to_eur(high, currency, rates)
        eur_low = native_to_eur(low, currency, rates)
        native_turnover = last * volume if last is not None else None
        eur_turnover = native_to_eur(native_turnover, currency, rates)
        return {
            **listing,
            "fundId": fund["id"],
            "isin": fund["isin"],
            "name": meta.get("longName") or fund["name"],
            "index": fund["index"],
            "exchange": listing["exchange"],
            "nativeLast": last,
            "last": eur_last,
            "eurLast": eur_last,
            "currency": currency,
            "previous": previous,
            "changePercent": change_percent,
            "high": high,
            "low": low,
            "eurHigh": eur_high,
            "eurLow": eur_low,
            "volume": volume,
            "turnover": eur_turnover,
            "nav": None,
            "navPremiumPercent": None,
            "date": quote_local.strftime("%Y%m%d") if quote_local else "",
            "state": "open" if is_open else "closed",
            "delay": "Retraso variable",
            "sourceLabel": "Yahoo público",
            "sourceUrl": YAHOO_SOURCE,
            "official": False,
            "quoteTimestamp": quote_time.isoformat().replace("+00:00", "Z") if quote_time else None,
        }

    def quotes(self, rates: dict[str, float]) -> tuple[list[dict[str, Any]], list[str]]:
        now = time.time()
        if self._cached_rows and now - self._cached_at < POLL_SECONDS:
            return self._cached_rows, self._cached_warnings
        targets = [
            (fund, listing)
            for fund in UNIVERSE["funds"]
            for listing in fund["listings"]
            if listing.get("provider") == "yahoo"
        ]
        rows: list[dict[str, Any]] = []
        warnings: list[str] = []
        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
            future_map = {pool.submit(self._get_listing, fund, listing, rates): listing for fund, listing in targets}
            for future in as_completed(future_map):
                listing = future_map[future]
                try:
                    rows.append(future.result())
                except Exception as exc:
                    warnings.append(f"{listing['ticker']}: {exc}")
        rows.sort(key=lambda row: (row["fundId"], row["exchange"], row["ticker"]))
        if rows:
            self._cached_rows, self._cached_warnings, self._cached_at = rows, warnings, now
        return rows, warnings


class CombinedProvider:
    name = "BME + mercados internacionales"

    def __init__(self) -> None:
        self.bme = BmeProvider()
        self.yahoo = YahooProvider()
        self.fx = EcbFxProvider()

    def quotes(self, fund_id: str = "all") -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        warnings: list[str] = []
        fx_date = ""
        try:
            bme_payload = self.bme.quotes("all")
            rows.extend(bme_payload["quotes"])
            bme_session = bme_payload.get("sessionDate", "")
        except Exception as exc:
            bme_session = ""
            warnings.append(f"BME: {exc}")
        try:
            rates, fx_date = self.fx.rates()
            yahoo_rows, yahoo_warnings = self.yahoo.quotes(rates)
            rows.extend(yahoo_rows)
            warnings.extend(yahoo_warnings)
        except Exception as exc:
            warnings.append(f"Internacional: {exc}")
        if fund_id != "all":
            rows = [row for row in rows if row["fundId"] == fund_id]
        if not rows:
            raise RuntimeError("No se pudo obtener ninguna cotización pública")
        return {
            "provider": self.name,
            "providerCode": "combined-public",
            "quality": "mixed-delayed",
            "delayMinutes": None,
            "timestamp": utc_now(),
            "sessionDate": bme_session,
            "fxDate": fx_date,
            "sources": [
                {"name": "BME", "official": True, "delay": "15 minutos", "url": BME_SOURCE},
                {"name": "Yahoo Finance", "official": False, "delay": "variable/no garantizado", "url": YAHOO_SOURCE},
                {"name": "BCE", "official": True, "delay": "tipo diario", "url": ECB_FX},
            ],
            "warnings": warnings,
            "quotes": rows,
        }


PROVIDER = CombinedProvider()


class AtlasHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/universe":
            self._json(UNIVERSE)
            return
        if parsed.path == "/api/status":
            self._json({"provider": PROVIDER.name, "providerCode": "combined-public", "pollSeconds": POLL_SECONDS, "timestamp": utc_now()})
            return
        if parsed.path == "/api/stream":
            params = urllib.parse.parse_qs(parsed.query)
            fund_id = params.get("fund_id", ["all"])[0]
            valid_ids = {fund["id"] for fund in UNIVERSE["funds"]}
            if fund_id != "all" and fund_id not in valid_ids:
                self._json({"error": "Fondo no encontrado"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                while True:
                    try:
                        data = PROVIDER.quotes(fund_id)
                        event = "quotes"
                    except Exception as exc:
                        data = {"provider": PROVIDER.name, "providerCode": "combined-public", "quality": "error", "timestamp": utc_now(), "error": str(exc), "quotes": []}
                        event = "feed-error"
                    message = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")
                    self.wfile.write(message)
                    self.wfile.flush()
                    time.sleep(POLL_SECONDS)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.close_connection = True
            return
        super().do_GET()


if __name__ == "__main__":
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer((HOST, PORT), AtlasHandler)
    public_host = "localhost" if HOST == "127.0.0.1" else HOST
    print(f"Atlas ETF en http://{public_host}:{PORT} | proveedor: {PROVIDER.name}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
