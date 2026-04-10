///usr/bin/env gorun "$0" "$@"; exit $?
// dep require github.com/fatih/color v1.18.0
// sum sha256:2b4d965193a48ed6afe11d60280eea62696620c1ae8183fac83113619286392f

package main

import (
	"fmt"

	"github.com/fatih/color"
)

func main() {
	green := color.New(color.FgGreen, color.Bold).SprintFunc()
	red := color.New(color.FgRed).SprintFunc()
	cyan := color.New(color.FgCyan, color.Underline).SprintFunc()

	fmt.Println(green("✔ gorun works with dependencies!"))
	fmt.Println(red("✘ This is a red error message"))
	fmt.Println(cyan("→ https://github.com/fatih/color"))
	fmt.Printf("\nThis script was run via %s with an external dep.\n", green("gorun"))
}
