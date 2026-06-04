from __future__ import annotations

from machine import Pin


class Relay:
    def __init__(self, pin: Pin) -> None:
        self._pin = pin

    def on(self) -> None:
        pass

    def off(self) -> None:
        pass
