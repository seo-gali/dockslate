use serde_json::Value;

pub(super) const SIZE: usize = 16;

#[derive(Debug)]
pub(super) enum ReadError {
    Timeout(String),
    Other(String),
}
impl ReadError {
    pub fn message(self) -> String {
        match self { Self::Timeout(message) | Self::Other(message) => message }
    }
}

pub(super) fn inspect<F>(values: &[String], mut read: F) -> Result<Vec<Value>, String>
where F: FnMut(&[String]) -> Result<Vec<Value>, ReadError> {
    fn append<F>(values: &[String], read: &mut F, output: &mut Vec<Value>) -> Result<(), String>
    where F: FnMut(&[String]) -> Result<Vec<Value>, ReadError> {
        match read(values) {
            Ok(rows) if rows.len() == values.len() => { output.extend(rows); Ok(()) }
            Ok(_) => Err("Docker 검사 대상이 달라졌습니다. 다시 검사하세요.".into()),
            Err(ReadError::Timeout(_)) if values.len() > 1 => {
                let middle = values.len() / 2;
                append(&values[..middle], read, output)?;
                append(&values[middle..], read, output)
            }
            Err(error) => Err(error.message()),
        }
    }
    let mut output = Vec::with_capacity(values.len());
    for chunk in values.chunks(SIZE) { append(chunk, &mut read, &mut output)?; }
    Ok(output)
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inspection_batches_preserve_order_and_bound_each_command() {
        let values: Vec<_> = (0..130).map(|v| v.to_string()).collect();
        let mut calls = 0;
        let rows = inspect(&values, |batch| {
            calls += 1; assert!(batch.len() <= SIZE);
            Ok(batch.iter().map(|v| json!(v)).collect())
        }).unwrap();
        assert_eq!(calls, 9);
        assert_eq!(rows, values.iter().map(|v| json!(v)).collect::<Vec<_>>());
    }

    #[test]
    fn only_timed_out_read_batches_split_and_a_single_timeout_stops() {
        let values: Vec<_> = (0..19).map(|v| v.to_string()).collect();
        let rows = inspect(&values, |batch| {
            if batch.len() > 3 { return Err(ReadError::Timeout("slow".into())); }
            Ok(batch.iter().map(|v| json!(v)).collect())
        }).unwrap();
        assert_eq!(rows.len(), values.len());
        let mut calls = 0;
        assert_eq!(inspect(&values, |_| { calls += 1; Err(ReadError::Other("denied".into())) }).unwrap_err(), "denied");
        assert_eq!(calls, 1);
        calls = 0;
        assert_eq!(inspect(&values[..1], |_| { calls += 1; Err(ReadError::Timeout("slow".into())) }).unwrap_err(), "slow");
        assert_eq!(calls, 1);
        assert!(inspect(&values, |_| Ok(vec![])).is_err());
    }
}
