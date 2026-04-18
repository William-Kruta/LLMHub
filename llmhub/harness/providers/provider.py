import logging
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class Provider(ABC):
    def __init__(self, name: str):
        self.name = name

    @abstractmethod
    def chat(self, messages: list[dict], **kwargs) -> str:
        """Send a list of messages and return the model's text response."""
