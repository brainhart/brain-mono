package main

import "fmt"

func Greet(name string) string {
	return fmt.Sprintf("Hello from hello-go, %s!", name)
}

func main() {
	fmt.Println(Greet("world"))
}
