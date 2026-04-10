fn greet(name: &str) -> String {
    format!("Hello from hello-rust, {name}!")
}

fn main() {
    println!("{}", greet("world"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_greet() {
        assert_eq!(greet("world"), "Hello from hello-rust, world!");
    }
}
