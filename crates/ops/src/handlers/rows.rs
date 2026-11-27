//! SQLite rows as the JSON objects every read shows: a column's value by its
//! storage class, and a stored JSON column parsed.

use db::rusqlite::types::ValueRef;
use db::rusqlite::{Connection, Params};
use serde_json::{Map, Value};

use crate::context::OpError;

pub(crate) type Row = Map<String, Value>;

/// Every row of `sql` as an object keyed by its column names, in order.
pub(crate) fn all(sqlite: &Connection, sql: &str, params: impl Params) -> Result<Vec<Row>, OpError> {
    let mut statement = sqlite.prepare(sql)?;
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let mut cursor = statement.query(params)?;
    let mut rows = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            record.insert(name.clone(), cell(row.get_ref(index)?));
        }
        rows.push(record);
    }
    Ok(rows)
}

/// One column's value. A real without a fraction is written as an integer,
/// as every number in this output is; a blob as its bytes.
pub(crate) fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        ValueRef::Real(number) => foundation::js::json_number(number),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => Value::from(bytes.to_vec()),
    }
}

/// A stored JSON column parsed; SQL `NULL` is `null`.
pub(crate) fn json_column(text: Option<&str>) -> Result<Value, OpError> {
    match text {
        None => Ok(Value::Null),
        Some(text) => Ok(serde_json::from_str(text)?),
    }
}

pub(crate) fn text<'r>(row: &'r Row, name: &str) -> &'r str {
    row.get(name).and_then(Value::as_str).unwrap_or_default()
}

pub(crate) fn int(row: &Row, name: &str) -> i64 {
    row.get(name).and_then(Value::as_i64).unwrap_or_default()
}
