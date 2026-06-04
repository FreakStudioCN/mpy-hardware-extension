import json
from pathlib import Path

from scripts.ingest_graftsense import ingest_repo_dir


REPO = Path(__file__).parent / "fixtures" / "package_sources" / "graftsense_repo"


def _by_name(index):
    return {record["name"]: record for record in index}


def test_repo_ingestion_promotes_all_bus_types_to_generatable(tmp_path):
    evidence = ingest_repo_dir(REPO, tmp_path)
    index = _by_name(json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8")))

    # I2C sensor -> generatable, capabilities inferred (not hardcoded), github mip ref.
    aht20 = index["fix_aht20"]
    assert aht20["support_level"] == "generatable"
    assert aht20["source"] == "graftsense"
    assert aht20["package_json_url"] == "github:FreakStudioCN/GraftSense-Drivers-MicroPython/sensors/aht20"
    assert aht20["repository_url"] == "https://github.com/FreakStudioCN/GraftSense-Drivers-MicroPython"
    assert "temperature_sensing" in aht20["capabilities"]
    aht20_ctx = json.loads((tmp_path / aht20["driver_context_ref"]).read_text(encoding="utf-8"))
    assert aht20_ctx["bus"] == ["i2c"]
    assert aht20_ctx["pin_roles"] == ["i2c_sda", "i2c_scl"]
    assert "AHT20(i2c)" in aht20_ctx["constructors"]
    assert "temperature" in aht20_ctx["read_properties"]

    # The Phase B win: non-I2C buses also reach generatable with correct pin roles.
    uart_ctx = json.loads((tmp_path / index["fix_uart_modem"]["driver_context_ref"]).read_text(encoding="utf-8"))
    assert uart_ctx["bus"] == ["uart"]  # detected from the *unannotated* `uart` param
    assert uart_ctx["pin_roles"] == ["uart_tx", "uart_rx"]
    assert "UartModem(uart, rx_timeout_ms)" in uart_ctx["constructors"]

    relay_ctx = json.loads((tmp_path / index["fix_relay_out"]["driver_context_ref"]).read_text(encoding="utf-8"))
    assert relay_ctx["bus"] == ["gpio"]
    assert relay_ctx["pin_roles"] == ["gpio"]

    spi_ctx = json.loads((tmp_path / index["fix_spicard"]["driver_context_ref"]).read_text(encoding="utf-8"))
    assert spi_ctx["bus"] == ["spi"]
    assert spi_ctx["pin_roles"] == ["spi_sck", "spi_mosi", "spi_miso", "spi_cs"]
    assert "Card(spi, cs, baudrate)" in spi_ctx["constructors"]

    assert evidence["generatable"] == 4
    assert evidence["installable"] == 1


def test_repo_ingestion_leaves_busless_driver_installable(tmp_path):
    ingest_repo_dir(REPO, tmp_path)
    index = _by_name(json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8")))

    data_pack = index["fix_data_pack"]
    assert data_pack["support_level"] == "installable"
    assert "driver_context_ref" not in data_pack
    assert not (tmp_path / "driver_context" / "fix_data_pack-1.0.0.json").exists()


def test_repo_ingestion_prunes_fake_seed_and_supersedes_weaker_upypi(tmp_path):
    # Pre-seed the index with the fake graftsense seed + a weak upypi record that
    # points at the same repo driver as the real sensors/aht20.
    (tmp_path / "driver_context").mkdir(parents=True)
    seed = [
        {"name": "graftsense_aht20", "version": "1.0.0", "source": "graftsense",
         "package_json_url": "https://graftsense.example/aht20/package.json",
         "support_level": "generatable", "urls": []},
        {"name": "aht20_upypi", "version": "1.0.0", "source": "upypi",
         "package_json_url": "https://upypi.net/pkgs/aht20_upypi/1.0.0/package.json",
         "support_level": "installable",
         "urls": [["aht20.py", "github:FreakStudioCN/GraftSense-Drivers-MicroPython/sensors/aht20/code/aht20.py"]]},
    ]
    (tmp_path / "package_index.json").write_text(json.dumps(seed), encoding="utf-8")

    ingest_repo_dir(REPO, tmp_path)
    index = json.loads((tmp_path / "package_index.json").read_text(encoding="utf-8"))
    names = [record["name"] for record in index]

    # Fake seed gone; the weak upypi dup superseded by the real generatable record.
    assert "graftsense_aht20" not in names
    assert "aht20_upypi" not in names
    assert names.count("fix_aht20") == 1
    assert _by_name(index)["fix_aht20"]["support_level"] == "generatable"
