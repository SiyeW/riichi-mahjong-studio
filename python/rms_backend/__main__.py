"""Run the Riichi Mahjong Studio backend service."""

import sys


if __name__ == "__main__":
    if '--record-codec-worker' in sys.argv[1:]:
        from rms_backend.records.codec_worker import main
    else:
        from rms_backend.service import main
    main()
