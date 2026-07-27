use std::{fs, path::Path};

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn create_windows_icon(path: &Path) {
    const SIZE: u32 = 32;
    const PIXEL_BYTES: u32 = SIZE * SIZE * 4;
    const MASK_BYTES: u32 = (SIZE / 8) * SIZE;
    const IMAGE_BYTES: u32 = 40 + PIXEL_BYTES + MASK_BYTES;

    let mut bytes = Vec::with_capacity((22 + IMAGE_BYTES) as usize);

    // ICONDIR
    push_u16(&mut bytes, 0);
    push_u16(&mut bytes, 1);
    push_u16(&mut bytes, 1);

    // ICONDIRENTRY
    bytes.push(SIZE as u8);
    bytes.push(SIZE as u8);
    bytes.push(0);
    bytes.push(0);
    push_u16(&mut bytes, 1);
    push_u16(&mut bytes, 32);
    push_u32(&mut bytes, IMAGE_BYTES);
    push_u32(&mut bytes, 22);

    // BITMAPINFOHEADER. Icon bitmap height includes both the color bitmap and mask.
    push_u32(&mut bytes, 40);
    push_u32(&mut bytes, SIZE);
    push_u32(&mut bytes, SIZE * 2);
    push_u16(&mut bytes, 1);
    push_u16(&mut bytes, 32);
    push_u32(&mut bytes, 0);
    push_u32(&mut bytes, PIXEL_BYTES);
    push_u32(&mut bytes, 0);
    push_u32(&mut bytes, 0);
    push_u32(&mut bytes, 0);
    push_u32(&mut bytes, 0);

    // BGRA pixels, bottom-up. Draw a steel-blue rounded cylinder label.
    for y in (0..SIZE).rev() {
        for x in 0..SIZE {
            let dx = x as i32 - 15;
            let dy = y as i32 - 15;
            let inside = dx * dx + dy * dy <= 220;
            let label = (7..=24).contains(&x) && (10..=21).contains(&y);
            let (red, green, blue, alpha) = if label {
                (235, 243, 249, 255)
            } else if inside {
                (40, 77, 108, 255)
            } else {
                (0, 0, 0, 0)
            };
            bytes.extend_from_slice(&[blue, green, red, alpha]);
        }
    }

    // Fully opaque AND mask for the bitmap area; alpha controls outer transparency.
    bytes.resize(bytes.len() + MASK_BYTES as usize, 0);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("failed to create icon directory");
    }
    fs::write(path, bytes).expect("failed to generate Windows icon");
}

fn main() {
    let icon_path = Path::new("icons/icon.ico");
    if !icon_path.exists() {
        create_windows_icon(icon_path);
    }
    tauri_build::build()
}
