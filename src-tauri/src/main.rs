// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![warn(clippy::pedantic, clippy::nursery)]

fn main() {
    if quill_lib::run_update_helper_if_requested() {
        return;
    }
    quill_lib::run();
}
