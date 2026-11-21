use serde_json::{Map, Value};

/// The objects of a stored JSON array column. A missing, empty or malformed
/// value, and every element that is not an object, reads as absent.
pub fn json_record_array(value: Option<&str>) -> Vec<Map<String, Value>> {
    let Some(Ok(Value::Array(items))) = value.filter(|text| !text.is_empty()).map(serde_json::from_str) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| match item {
            Value::Object(object) => Some(object),
            _ => None,
        })
        .collect()
}
