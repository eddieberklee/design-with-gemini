Import("env")
import os
import subprocess

def after_upload_watchdog_reset(source, target, env):
    # M5StickS3 uses M5PM1 + ESP32-S3 USB-Serial/JTAG (303A:1001).
    # If the board entered Download Mode via long-pressing power, standard RTS hard_reset
    # can remain in boot:0x20. Running esptool v4.11+ `--after watchdog_reset` cleanly boots SPI flash.
    port = env.subst("$UPLOAD_PORT")
    py = env.subst("$PYTHONEXE")
    esptool_411 = os.path.expanduser("~/.platformio/packages/tool-esptoolpy/esptool.py")
    if port and os.path.exists(esptool_411):
        subprocess.run(
            [py, esptool_411, "--port", port, "--after", "watchdog_reset", "chip_id"],
            check=False,
        )

env.AddPostAction("upload", after_upload_watchdog_reset)
