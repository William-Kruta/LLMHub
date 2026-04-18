from langchain_core.tools import tool

# YahooRS 
from yahoors.modules.candles import Candles
from yahoors.modules.statements import Statements 
from yahoors.modules.options import Options



@tool
def get_candles(tickers: list[str], interval: str = "1d", period: str = "max"): 
    """Fetch historical OHLCV (open, high, low, close, volume) candlestick data for one or more stock tickers.

    Args:
        tickers: List of stock ticker symbols (e.g. ["AAPL", "MSFT"]).
        interval: Time interval between candles. Valid values: "1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo".
        period: Historical lookback period. Valid values: "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max".

    Returns:
        DataFrame containing date, open, high, low, close, and volume columns for each ticker.
    """
    obj = Candles()
    data = obj.get_candles(tickers, interval=interval, period=period)
    return data

@tool
def get_options(tickers: list[str]): 
    """Fetch the latest options chain (calls and puts) for one or more stock tickers.

    Args:
        tickers: List of stock ticker symbols (e.g. ["AAPL", "TSLA"]).

    Returns:
        DataFrame containing the most recent options contracts with strike prices, expiration dates, bid/ask, volume, and open interest.
    """
    obj = Options()
    data = obj.get_options(tickers, get_latest=True)
    return data

@tool
def get_income_statements(tickers: list[str], period: str = "A"): 
    """Fetch income statement financial data (revenue, net income, EPS, etc.) for one or more stock tickers.

    Args:
        tickers: List of stock ticker symbols (e.g. ["AAPL", "GOOG"]).
        period: Reporting period. "A" for annual, "Q" for quarterly.

    Returns:
        DataFrame containing income statement line items across reporting periods.
    """
    obj = Statements()
    data = obj.get_income_statement(tickers, period=period)
    return data

@tool
def get_balance_sheet(tickers: list[str], period: str = "A"): 
    """Fetch balance sheet financial data (assets, liabilities, equity) for one or more stock tickers.

    Args:
        tickers: List of stock ticker symbols (e.g. ["AAPL", "AMZN"]).
        period: Reporting period. "A" for annual, "Q" for quarterly.

    Returns:
        DataFrame containing balance sheet line items across reporting periods.
    """
    obj = Statements()
    data = obj.get_balance_sheet(tickers, period=period)
    return data

@tool
def get_cash_flow(tickers: list[str], period: str = "A"): 
    """Fetch cash flow statement data (operating, investing, financing activities) for one or more stock tickers.

    Args:
        tickers: List of stock ticker symbols (e.g. ["AAPL", "META"]).
        period: Reporting period. "A" for annual, "Q" for quarterly.

    Returns:
        DataFrame containing cash flow line items across reporting periods.
    """
    obj = Statements()
    data = obj.get_cash_flow(tickers, period=period)
    return data


STOCK_TOOL_MAP = {
    "get_candles": get_candles,
    "get_options": get_options,
    "get_income_statements": get_income_statements,
    "get_balance_sheet": get_balance_sheet,
    "get_cash_flow": get_cash_flow,
}
