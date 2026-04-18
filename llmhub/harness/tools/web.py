from ddgs import DDGS
import requests
from bs4 import BeautifulSoup
from langchain_core.tools import tool

@tool
def web_search(query: str) -> str:
    """Search the web using DuckDuckGo and return text snippets from the top results.

    Args:
        query: Search query string (e.g. "latest AI news", "Python asyncio tutorial").

    Returns:
        Concatenated text snippets from the top 5 search results.
    """
    with DDGS() as ddgs:
        results = ddgs.text(query, max_results=5)
        return "\n".join([r["body"] for r in results])


@tool
def fetch_page(url: str, max_chars: int = 5000) -> str:
    """Fetch a web page and extract its readable text content, stripping scripts, styles, and navigation elements.

    Args:
        url: Full URL to fetch (e.g. "https://example.com/article").
        max_chars: Maximum number of characters to return from the extracted text. Defaults to 5000.

    Returns:
        Plain text content extracted from the page, truncated to max_chars.
    """
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    return text[:max_chars]

@tool
def news_search(query: str, max_results: int = 5) -> str:
    """Search for recent news articles using DuckDuckGo News, returning titles, dates, and summaries.

    Args:
        query: News search query (e.g. "Tesla earnings", "Fed interest rate decision").
        max_results: Maximum number of news articles to return. Defaults to 5.

    Returns:
        Formatted string of news articles with titles, publication dates, and body text.
    """
    with DDGS() as ddgs:
        results = ddgs.news(query, max_results=max_results)
        return "\n".join(
            f"[{r['title']}] ({r['date']})\n{r['body']}" for r in results
        )

@tool
def image_search(query: str, max_results: int = 3) -> list[str]:
    """Search for images using DuckDuckGo and return direct image URLs.

    Args:
        query: Image search query (e.g. "golden retriever puppy", "Mount Everest").
        max_results: Maximum number of image URLs to return. Defaults to 3.

    Returns:
        List of direct image URL strings.
    """
    with DDGS() as ddgs:
        results = ddgs.images(query, max_results=max_results)
        return [r["image"] for r in results]

@tool
def wikipedia_summary(topic: str) -> str:
    """Retrieve a concise Wikipedia summary for a given topic using the Wikimedia REST API.

    Args:
        topic: Wikipedia article title or topic (e.g. "Python_(programming_language)", "Albert Einstein").

    Returns:
        Article title and extract text, or "No Wikipedia article found." if the topic doesn't exist.
    """
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{topic}"
    resp = requests.get(url, timeout=10)
    if resp.status_code == 200:
        data = resp.json()
        return f"{data['title']}\n{data['extract']}"
    return "No Wikipedia article found."

@tool
def search_and_fetch(query: str, max_results: int = 3) -> str:
    """Perform a web search and then fetch the full page content from each top result. Combines search and fetch in one step for deeper research.

    Args:
        query: Search query string.
        max_results: Number of top search results to fetch full content from. Defaults to 3.

    Returns:
        Concatenated full-text content from each result page, separated by result titles.
    """
    with DDGS() as ddgs:
        results = ddgs.text(query, max_results=max_results)
    pages = []
    for r in results:
        try:
            content = fetch_page(r["href"], max_chars=3000)
            pages.append(f"--- {r['title']} ---\n{content}")
        except requests.RequestException:
            pages.append(f"--- {r['title']} ---\n{r['body']}")
    return "\n\n".join(pages)



@tool
def search_subreddit(subreddit: str, sort: str = "hot", limit: int = 10) -> str:
    """Fetch top posts from a specified subreddit using Reddit's JSON API.

    Args:
        subreddit: Subreddit name without the "r/" prefix (e.g. "python", "machinelearning").
        sort: Post sorting method. Valid values: "hot", "new", "top", "rising". Defaults to "hot".
        limit: Maximum number of posts to return. Defaults to 10.

    Returns:
        Formatted string of posts with titles, scores, comment counts, and preview text/URLs.
    """
    url = f"https://www.reddit.com/r/{subreddit}/{sort}.json"
    resp = requests.get(
        url,
        headers={"User-Agent": "useragent-1.0"},
        params={"limit": limit},
        timeout=10,
    )
    if resp.status_code != 200:
        return f"Failed to fetch r/{subreddit}"

    posts = resp.json()["data"]["children"]
    results = []
    for post in posts:
        p = post["data"]
        results.append(
            f"• {p['title']} (↑{p['score']}, {p['num_comments']} comments)\n"
            f"  {p.get('selftext', '')[:200] or p.get('url', '')}"
        )
    return "\n\n".join(results)

WEB_TOOL_MAP = {
    "web_search": web_search,
    "fetch_page": fetch_page,
    "news_search": news_search,
    "image_search": image_search,
    "wikipedia_summary": wikipedia_summary,
    "search_and_fetch": search_and_fetch,
    "search_subreddit": search_subreddit,
}