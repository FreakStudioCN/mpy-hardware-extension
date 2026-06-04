from __future__ import annotations

from machine import I2C


class AHT20:
    def __init__(self, i2c: I2C) -> None:
        self._i2c = i2c

    @property
    def temperature(self) -> float:
        return 23.0

    def reset(self) -> None:
        pass
