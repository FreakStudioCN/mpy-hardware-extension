from machine import I2C, Pin
import aht20

# Demo app with concrete pins — must be excluded from extraction.
i2c = I2C(0, scl=Pin(5), sda=Pin(4))
sensor = aht20.AHT20(i2c)
print(sensor.temperature)
