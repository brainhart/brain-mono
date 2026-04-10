from main import main


def test_main(capsys):
    main()
    captured = capsys.readouterr()
    assert "Hello from hello-py!" in captured.out
