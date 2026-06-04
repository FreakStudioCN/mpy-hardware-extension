from __future__ import annotations


class DataPack:
    # No hardware bus dependency -> cannot be code-generated against, stays installable.
    def __init__(self, value: int) -> None:
        self._value = value

    def get(self) -> int:
        return self._value
