from __future__ import annotations

from machine import SPI, Pin


class Card:
    def __init__(self, spi: SPI, cs: Pin, baudrate: int = 1320000) -> None:
        self._spi = spi
        self._cs = cs

    def read_block(self, n: int) -> bytes:
        return b""
