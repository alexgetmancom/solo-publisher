//! `sqlite.query(sql).all(...)`: rows as objects keyed by column name, in
//! column order, the way bun:sqlite hands them back.

use db::rusqlite::types::ValueRef;
use db::rusqlite::{Connection, Params};
use serde_json::{Map, Value};

use crate::context::OpError;

pub type Row = Map<String, Value>;

pub fn all(sqlite: &Connection, sql: &str, params: impl Params) -> Result<Vec<Row>, OpError> {
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

fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        ValueRef::Real(number) => crate::schema::number_value(number),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => Value::Array(bytes.iter().map(|byte| Value::from(*byte)).collect()),
    }
}

pub fn text<'r>(row: &'r Row, name: &str) -> &'r str {
    row.get(name).and_then(Value::as_str).unwrap_or_default()
}

pub fn int(row: &Row, name: &str) -> i64 {
    row.get(name).and_then(Value::as_i64).unwrap_or_default()
}
