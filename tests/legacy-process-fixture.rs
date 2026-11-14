use std::io::{self, Write};

fn main() {
    println!("ready");
    io::stdout().flush().unwrap();
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
}
