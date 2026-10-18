use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL: Duration = Duration::from_millis(80);

fn write(s: &str) {
    let mut out = std::io::stdout().lock();
    // A closed stdout (e.g. piped into `head`) must not abort the fetch;
    // the spinner is cosmetic, so its write errors are deliberately ignored.
    let _ = out.write_all(s.as_bytes());
    let _ = out.flush();
}

// Mirrors @std/fmt/colors: honour NO_COLOR, otherwise always emit ANSI codes.
fn bold_colored(symbol: &str, color_code: u8) -> String {
    if std::env::var_os("NO_COLOR").is_some() {
        symbol.to_string()
    } else {
        format!("\x1B[1m\x1B[{color_code}m{symbol}\x1B[39m\x1B[22m")
    }
}

pub struct Spinner {
    text: String,
    stop: Option<(Sender<()>, JoinHandle<()>)>,
}

impl Spinner {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            stop: None,
        }
    }

    pub fn start(&mut self) {
        write("\x1B[?25l"); // hide cursor
        let (tx, rx) = mpsc::channel();
        let text = self.text.clone();
        let handle = std::thread::spawn(move || {
            let mut frame = 0;
            while let Err(RecvTimeoutError::Timeout) = rx.recv_timeout(INTERVAL) {
                frame = (frame + 1) % FRAMES.len();
                write(&format!("\r\x1B[2K{} {}", FRAMES[frame], text));
            }
        });
        self.stop = Some((tx, handle));
    }

    pub fn succeed(&mut self, text: &str) {
        self.halt();
        write(&format!("{} {}\n", bold_colored("✔", 32), text));
    }

    pub fn fail(&mut self, text: &str) {
        self.halt();
        write(&format!("{} {}\n", bold_colored("✖", 31), text));
    }

    fn halt(&mut self) {
        if let Some((tx, handle)) = self.stop.take() {
            drop(tx);
            handle.join().expect("spinner thread panicked");
        }
        write("\r\x1B[2K\x1B[?25h"); // clear line + show cursor
    }
}
