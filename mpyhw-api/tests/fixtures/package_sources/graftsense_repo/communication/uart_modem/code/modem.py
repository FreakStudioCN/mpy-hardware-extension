from __future__ import annotations


class UartModem:
    # Unannotated bus param (like the real HC08) — exercises name-based detection.
    def __init__(self, uart, rx_timeout_ms=600):
        self._uart = uart

    def send(self, data):
        pass

    def receive(self):
        return b""
