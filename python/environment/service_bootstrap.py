"""PyInstaller entry point for the host environment service."""


def main() -> None:
    from service import main as run_environment_service

    run_environment_service()


if __name__ == "__main__":
    main()
