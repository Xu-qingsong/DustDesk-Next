use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

pub fn merge_value(
    latest: Option<&Value>,
    incoming: Option<&Value>,
    baseline: Option<&Value>,
) -> Option<Value> {
    if incoming == baseline {
        return latest.cloned();
    }
    if latest == baseline {
        return incoming.cloned();
    }
    if let (
        Some(Value::Array(latest)),
        Some(Value::Array(incoming)),
        Some(Value::Array(baseline)),
    ) = (latest, incoming, baseline)
    {
        let has_ids = |records: &[Value]| {
            records
                .iter()
                .all(|value| value.get("Id").is_some_and(Value::is_string))
        };
        if has_ids(latest) && has_ids(incoming) && has_ids(baseline) {
            let previous: HashMap<&str, &Value> = baseline
                .iter()
                .map(|item| (item["Id"].as_str().unwrap(), item))
                .collect();
            let current: HashMap<&str, &Value> = latest
                .iter()
                .map(|item| (item["Id"].as_str().unwrap(), item))
                .collect();
            let incoming_ids: BTreeSet<&str> = incoming
                .iter()
                .map(|item| item["Id"].as_str().unwrap())
                .collect();
            let mut output = Vec::new();
            for item in incoming {
                let id = item["Id"].as_str().unwrap();
                match (previous.get(id), current.get(id)) {
                    (Some(_), None) => {}
                    (Some(previous), Some(current)) => {
                        if let Some(value) = merge_value(Some(current), Some(item), Some(previous))
                        {
                            output.push(value);
                        }
                    }
                    _ => output.push(item.clone()),
                }
            }
            for item in latest {
                let id = item["Id"].as_str().unwrap();
                if !incoming_ids.contains(id) && !previous.contains_key(id) {
                    output.push(item.clone());
                }
            }
            return Some(Value::Array(output));
        }
    }
    if let (
        Some(Value::Object(latest)),
        Some(Value::Object(incoming)),
        Some(Value::Object(baseline)),
    ) = (latest, incoming, baseline)
    {
        let keys: BTreeSet<&String> = latest
            .keys()
            .chain(incoming.keys())
            .chain(baseline.keys())
            .collect();
        let mut output = Map::new();
        for key in keys {
            if let Some(value) = merge_value(latest.get(key), incoming.get(key), baseline.get(key))
            {
                output.insert(key.clone(), value);
            }
        }
        return Some(Value::Object(output));
    }
    incoming.cloned()
}

pub fn merge_workspace(latest: &Value, incoming: &Value, baseline: &Value) -> Value {
    merge_value(Some(latest), Some(incoming), Some(baseline)).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_independent_fields_additions_and_deletions() {
        let baseline =
            json!({"Notes":[{"Id":"a","Title":"old","Text":"old"}],"Unknown":{"one":1,"two":2}});
        let latest = json!({"Notes":[{"Id":"a","Title":"new","Text":"old"},{"Id":"b","Text":"background"}],"Unknown":{"one":3,"two":2}});
        let incoming =
            json!({"Notes":[{"Id":"a","Title":"old","Text":"draft"}],"Unknown":{"one":1,"two":4}});
        assert_eq!(
            merge_workspace(&latest, &incoming, &baseline),
            json!({"Notes":[{"Id":"a","Title":"new","Text":"draft"},{"Id":"b","Text":"background"}],"Unknown":{"one":3,"two":4}})
        );
        assert_eq!(
            merge_workspace(&json!({"Notes":[]}), &baseline, &baseline),
            json!({"Notes":[]})
        );
        let incoming = json!({"Notes":[{"Id":"a","Text":"changed"}]});
        assert_eq!(
            merge_workspace(&json!({"Notes":[]}), &incoming, &baseline)["Notes"],
            json!([])
        );
    }

    #[test]
    fn missing_fields_remain_distinct_from_explicit_null() {
        let baseline = json!({"one":null,"two":1});
        let incoming = json!({"two":1});
        let latest = json!({"one":null,"two":2,"three":3});
        assert_eq!(
            merge_workspace(&latest, &incoming, &baseline),
            json!({"two":2,"three":3})
        );
        assert_eq!(
            merge_workspace(
                &json!({"names":["background"]}),
                &json!({"names":["draft"]}),
                &json!({"names":[]})
            ),
            json!({"names":["draft"]})
        );
    }
}
