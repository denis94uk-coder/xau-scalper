from teo.assets import REGISTRY, assets, get_asset, live_symbols


def test_registry_has_expected_tiers():
    assert any(a.tier == 1 for a in REGISTRY)
    assert any(a.tier == 2 for a in REGISTRY)
    assert any(a.tier == 3 for a in REGISTRY)


def test_get_asset_case_insensitive():
    a = get_asset("btcusdt")
    assert a is not None and a.symbol == "BTCUSDT" and a.label == "Bitcoin"
    assert get_asset("NOPE") is None


def test_gold_is_metal_tier1_binance():
    g = get_asset("PAXGUSDT")
    assert g.kind == "metal" and g.tier == 1 and g.source == "binance"


def test_stocks_are_market_hours():
    stocks = assets(tier=3)
    assert len(stocks) == 7
    assert all(a.market_hours and a.source == "stock" for a in stocks)


def test_live_symbols_are_binance_only():
    live = live_symbols()
    assert "BTCUSDT" in live and "PAXGUSDT" in live
    assert "AAPL" not in live  # stocks aren't on the free Binance feed
    assert "XMRUSD" not in live  # kraken, not binance


def test_filter_by_source():
    assert {a.source for a in assets(source="binance")} == {"binance"}
