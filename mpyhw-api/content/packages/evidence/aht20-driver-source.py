class AHT20:
    def __init__(self, i2c):
        self.i2c = i2c

    @property
    def temperature(self):
        return 24.5

    @property
    def relative_humidity(self):
        return 51.0
