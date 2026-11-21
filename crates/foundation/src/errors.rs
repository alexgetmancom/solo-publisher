use std::fmt;

/// A domain error whose user-facing text lives in the interface catalog.
///
/// Services stay language-agnostic: they return a stable `code`, and the
/// interface renders it through `i18n::describe_error`. A code that is not a
/// catalog key renders as itself, which is also what logs show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioError {
    pub code: String,
    /// `{name}` placeholder values, already rendered to text.
    pub params: Vec<(String, String)>,
}

impl StudioError {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: Vec::new(),
        }
    }

    pub fn with_param(mut self, name: impl Into<String>, value: impl fmt::Display) -> Self {
        self.params.push((name.into(), value.to_string()));
        self
    }
}

impl fmt::Display for StudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.code)
    }
}

impl std::error::Error for StudioError {}
