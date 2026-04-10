from hello_py import greet


def test_greet():
    assert greet("world") == "Hello from hello-py, world!"
