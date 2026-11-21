//! `multipart/form-data` bodies, written the way Bun serializes a `FormData`:
//! each part's `Content-Disposition`, a `Content-Type` for files, CRLF
//! framing. Files are streamed from disk by the transport, never read here.

use std::path::Path;

use runtime::http::{Body, BodyPart, HttpRequest};

pub struct Form {
    boundary: String,
    parts: Vec<BodyPart>,
}

impl Form {
    pub fn new() -> Self {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Self {
            boundary: format!("----WebKitFormBoundary{hex}"),
            parts: Vec::new(),
        }
    }

    /// A string field (`form.set(name, value)`).
    pub fn text(&mut self, name: &str, value: &str) {
        self.head(&format!(
            "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
            escape(name)
        ));
        self.parts.push(BodyPart::Bytes(value.as_bytes().to_vec()));
        self.parts.push(BodyPart::Bytes(b"\r\n".to_vec()));
    }

    /// A file field, its bytes read from `path` as the request goes out.
    pub fn file(&mut self, name: &str, path: &Path, filename: &str, content_type: &str) {
        self.file_head(name, filename, content_type);
        self.parts.push(BodyPart::File {
            path: path.to_owned(),
            offset: 0,
        });
        self.parts.push(BodyPart::Bytes(b"\r\n".to_vec()));
    }

    /// A file field whose bytes are already in memory (a `Blob`).
    pub fn blob(&mut self, name: &str, bytes: Vec<u8>, filename: &str, content_type: &str) {
        self.file_head(name, filename, content_type);
        self.parts.push(BodyPart::Bytes(bytes));
        self.parts.push(BodyPart::Bytes(b"\r\n".to_vec()));
    }

    fn file_head(&mut self, name: &str, filename: &str, content_type: &str) {
        self.head(&format!(
            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {content_type}\r\n\r\n",
            escape(name),
            escape(filename)
        ));
    }

    fn head(&mut self, headers: &str) {
        self.parts.push(BodyPart::Bytes(
            format!("--{}\r\n{headers}", self.boundary).into_bytes(),
        ));
    }

    /// The request with this form as its body and the content type `fetch`
    /// sets for a `FormData`.
    pub fn attach(mut self, request: HttpRequest) -> HttpRequest {
        self.parts
            .push(BodyPart::Bytes(format!("--{}--\r\n", self.boundary).into_bytes()));
        request
            .header(
                "content-type",
                format!("multipart/form-data; boundary={}", self.boundary),
            )
            .body(Body(self.parts))
    }
}

impl Default for Form {
    fn default() -> Self {
        Self::new()
    }
}

/// The escaping the HTML form encoding applies to names and filenames.
fn escape(value: &str) -> String {
    value.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A")
}
