use super::productivity::{self, Action};
use chrono::{Duration, TimeZone, Utc};
use serde_json::{json, Value};

fn fixture() -> Value {
    super::normalize::default_state()
}
fn start() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 9, 1, 0, 0).unwrap()
}
fn apply(state: &mut Value, action: Value, offset: i64) -> Result<(), productivity::ActionFailure> {
    productivity::apply(
        state,
        serde_json::from_value(action).unwrap(),
        start() + Duration::milliseconds(offset),
    )
}

#[test]
fn capture_checks_utf16_length_js_whitespace_and_stable_request_ids() {
    assert!(serde_json::from_value::<Action>(json!({"type":"capture","kind":"task","title":"not-a-new-request","text":"","requestId":null})).is_err());
    let mut state = fixture();
    assert!(apply(&mut state,json!({"type":"capture","kind":"note","title":"😀".repeat(151),"text":"","requestId":"too-long"}),0).is_err());
    assert!(apply(
        &mut state,
        json!({"type":"capture","kind":"task","title":"ok","text":"😀".repeat(100001)}),
        0
    )
    .is_err());
    apply(&mut state,json!({"type":"capture","kind":"note","title":"﻿  带空白的标题 ﻿","text":"正文","requestId":"stable-note"}),0).unwrap();
    let note = state["Notes"][0].clone();
    assert_eq!(note["Title"], "带空白的标题");
    let before = state.clone();
    apply(&mut state,json!({"type":"capture","kind":"task","title":"重试不能重复","text":"","requestId":"stable-note"}),10).unwrap();
    assert_eq!(state, before);
    state["Notes"].as_array_mut().unwrap().remove(0);
    state["RecycleBin"] =
        json!([{"Id":"recycled","kind":"note","value":note,"ExpiresAt":"2099-01-01"}]);
    let before = state.clone();
    apply(&mut state,json!({"type":"capture","kind":"note","title":"不能复活已删除记录","text":"","requestId":"stable-note"}),20).unwrap();
    assert_eq!(state, before);
    apply(&mut state,json!({"type":"capture","kind":"note","title":"","text":"","requestId":"javascript-not-whitespace"}),30).unwrap();
    assert_eq!(state["Notes"][0]["Title"], "");
}

#[test]
fn note_conflicts_and_deleted_notes_keep_public_error_codes() {
    let mut state = fixture();
    let note = state["Notes"][0].clone();
    let id = note["Id"].clone();
    apply(&mut state,json!({"type":"note-edit","id":id,"title":"第一窗口","text":"新正文","previousText":note["Text"],"previousTitle":note["Title"]}),0).unwrap();
    let before = state.clone();
    let conflict = apply(&mut state,json!({"type":"note-edit","id":id,"title":"迟到窗口","text":"草稿","previousText":note["Text"],"previousTitle":note["Title"]}),10).unwrap_err();
    assert_eq!(conflict.code, Some("NOTE_CONFLICT"));
    assert_eq!(state, before);
    state["Notes"] = json!([]);
    let deleted = apply(&mut state,json!({"type":"note-edit","id":id,"title":"不能复活","text":"草稿","previousText":"","previousTitle":""}),20).unwrap_err();
    assert_eq!(deleted.code, Some("NOTE_DELETED"));
}

#[test]
fn restoration_handles_missing_parent_and_filters_duplicate_links_without_losing_payload_fields() {
    let mut state = fixture();
    let link =
        json!({"Id":"link","Name":"name","Url":"https://example.com","Unknown":{"keep":true}});
    state["RecycleBin"] = json!([{"Id":"entry","kind":"link","value":link,"parent":{"Id":"missing-parent","Name":"old parent"},"ExpiresAt":"2099-01-01"}]);
    apply(
        &mut state,
        json!({"type":"recycle-restore","id":"entry"}),
        0,
    )
    .unwrap();
    assert_eq!(
        state["LinkGroups"].as_array().unwrap().last().unwrap()["Links"][0],
        link
    );
    state["RecycleBin"] = json!([{"Id":"group-entry","kind":"group","value":{"Id":"restored-group","Name":"restored","Links":[link,{"Id":"another","Name":"second","Url":"https://example.org"}]},"ExpiresAt":"2099-01-01"}]);
    apply(
        &mut state,
        json!({"type":"recycle-restore","id":"group-entry"}),
        1,
    )
    .unwrap();
    let restored = state["LinkGroups"].as_array().unwrap().last().unwrap();
    assert_eq!(restored["Links"].as_array().unwrap().len(), 1);
    assert_eq!(restored["Links"][0]["Id"], "another");
    state["RecycleBin"] = json!([{"Id":"duplicate","kind":"link","value":link,"parent":{"Id":"missing-parent","Name":"old parent"},"ExpiresAt":"2099-01-01"}]);
    let before = state.clone();
    assert!(apply(
        &mut state,
        json!({"type":"recycle-restore","id":"duplicate"}),
        2
    )
    .is_err());
    assert_eq!(state, before);
}

#[test]
fn rules_reject_invalid_patterns_duplicates_deleted_categories_and_preserve_unknown_fields() {
    let mut state = fixture();
    let category = state["DesktopCategories"][0]["Id"].clone();
    let rule = json!({"Id":"rule","Enabled":true,"Match":"extension","Pattern":"*.pdf，docx","CategoryId":category,"Unknown":[1,2]});
    apply(&mut state, json!({"type":"rules-save","rules":[rule]}), 0).unwrap();
    assert_eq!(state["OrganizerRules"][0]["Unknown"], json!([1, 2]));
    let mut invalid_pattern = rule.clone();
    invalid_pattern["Pattern"] = json!("，*.，.");
    for rules in [json!([rule, rule]), json!([invalid_pattern])] {
        let before = state.clone();
        assert!(apply(&mut state, json!({"type":"rules-save","rules":rules}), 0).is_err());
        assert_eq!(state, before);
    }
    let mut invalid = rule.clone();
    invalid["CategoryId"] = json!("missing");
    assert!(apply(
        &mut state,
        json!({"type":"rules-save","rules":[invalid]}),
        0
    )
    .is_err());
}

#[test]
fn focus_ticks_pause_after_sleep_and_finish_once_without_counting_offline_time() {
    let mut state = fixture();
    apply(
        &mut state,
        json!({"type":"focus-start","taskId":"","projectId":"","minutes":1.25}),
        0,
    )
    .unwrap();
    assert_eq!(state["ActiveFocus"]["PlannedSeconds"], 75.0);
    let id = state["ActiveFocus"]["Id"].clone();
    assert!(productivity::tick(
        &mut state,
        start() + Duration::seconds(5)
    ));
    assert!(productivity::tick(
        &mut state,
        start() + Duration::seconds(26)
    ));
    assert_eq!(state["ActiveFocus"]["ElapsedSeconds"], 5.0);
    assert!(state["ActiveFocus"]["RunningSince"].is_null());
    apply(&mut state, json!({"type":"focus-resume"}), 30_000).unwrap();
    assert!(productivity::tick(
        &mut state,
        start() + Duration::seconds(35)
    ));
    apply(&mut state, json!({"type":"focus-finish"}), 100_000).unwrap();
    assert!(state["ActiveFocus"].is_null());
    assert_eq!(state["FocusSessions"][0]["Id"], id);
    assert_eq!(state["FocusSessions"][0]["Seconds"], 75.0);
    assert_eq!(state["FocusSessions"][0]["Completed"], true);
    apply(&mut state, json!({"type":"focus-finish"}), 101_000).unwrap();
    assert_eq!(state["FocusSessions"].as_array().unwrap().len(), 1);
    assert!(apply(&mut state, json!({"type":"focus-pause"}), 102_000).is_err());
    assert!(apply(
        &mut state,
        json!({"type":"focus-start","taskId":"","projectId":"","minutes":0.5}),
        102_000
    )
    .is_err());
}

#[test]
fn focus_tick_completes_at_deadline_and_restart_uses_last_checkpoint_only() {
    let mut state = fixture();
    apply(
        &mut state,
        json!({"type":"focus-start","taskId":"","projectId":"","minutes":1}),
        0,
    )
    .unwrap();
    assert!(productivity::tick(
        &mut state,
        start() + Duration::seconds(5)
    ));
    let mut restarted = state.clone();
    assert!(productivity::recover(&mut restarted));
    assert_eq!(restarted["ActiveFocus"]["ElapsedSeconds"], 5.0);
    assert!(!productivity::recover(&mut restarted));
    for seconds in [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65] {
        productivity::tick(&mut state, start() + Duration::seconds(seconds));
    }
    assert!(state["ActiveFocus"].is_null());
    assert_eq!(state["FocusSessions"].as_array().unwrap().len(), 1);
    assert_eq!(state["FocusSessions"][0]["Seconds"], 60.0);
    assert_eq!(state["FocusSessions"][0]["Completed"], true);
    let mut empty = fixture();
    productivity::apply(&mut empty, Action::FocusCancel, start()).unwrap();
    assert!(!productivity::tick(&mut empty, start()));
}

#[test]
fn reminders_skip_completed_future_invalid_and_notified_tasks_and_advance_missed_repeats_once() {
    let mut state = fixture();
    let due = start() - Duration::days(17);
    state["Todos"] = json!([
        {"Id":"once","Title":"一次提醒","ReminderAt":productivity::time(due),"ReminderRepeat":"None"},
        {"Id":"daily","Title":"每日","ReminderAt":productivity::time(due),"ReminderRepeat":"Daily"},
        {"Id":"weekly","Title":"每周","ReminderAt":productivity::time(due),"ReminderRepeat":"Weekly"},
        {"Id":"fallback","Title":"","ReminderAt":productivity::time(start()),"ReminderRepeat":"None"},
        {"Id":"future","ReminderAt":productivity::time(start()+Duration::seconds(1))},
        {"Id":"done","ReminderAt":productivity::time(due),"IsCompleted":true},
        {"Id":"already","ReminderAt":productivity::time(due),"ReminderNotifiedAt":productivity::time(due)},
        {"Id":"invalid","ReminderAt":"invalid"},
        {"Id":"missing","ReminderAt":null}
    ]);
    let unchanged = state["Todos"].as_array().unwrap()[4..].to_vec();
    let notifications = productivity::reminders(&mut state, start());
    assert_eq!(
        notifications
            .iter()
            .map(|n| n.body.as_str())
            .collect::<Vec<_>>(),
        ["一次提醒", "每日", "每周", "有一项任务到期"]
    );
    assert_eq!(
        state["Todos"][0]["ReminderNotifiedAt"],
        productivity::time(start())
    );
    assert_eq!(
        state["Todos"][1]["ReminderAt"],
        productivity::time(start() + Duration::days(1))
    );
    assert_eq!(
        state["Todos"][2]["ReminderAt"],
        productivity::time(due + Duration::days(21))
    );
    assert!(state["Todos"][1]["ReminderNotifiedAt"].is_null());
    assert_eq!(&state["Todos"].as_array().unwrap()[4..], unchanged);
    assert!(productivity::reminders(&mut state, start()).is_empty());
}

#[test]
fn weekday_reminders_follow_local_calendar_across_weekends_and_multiple_missed_weeks() {
    // 2026-11-06 Friday 23:30 local, already Saturday in UTC-08:00's inverse.
    let zone = chrono::FixedOffset::west_opt(8 * 3600).unwrap();
    let friday = zone
        .with_ymd_and_hms(2026, 11, 6, 23, 30, 0)
        .unwrap()
        .with_timezone(&Utc);
    let monday = zone
        .with_ymd_and_hms(2026, 11, 9, 23, 30, 0)
        .unwrap()
        .with_timezone(&Utc);
    let mut state = fixture();
    state["Todos"] = json!([{"Title":"工作日","ReminderRepeat":"Weekdays","ReminderAt":productivity::time(friday)}]);
    assert_eq!(
        productivity::reminders_in_zone(&mut state, friday, zone).len(),
        1
    );
    assert_eq!(state["Todos"][0]["ReminderAt"], productivity::time(monday));
    let future = zone
        .with_ymd_and_hms(2026, 11, 23, 23, 30, 0)
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(
        productivity::reminders_in_zone(&mut state, future, zone).len(),
        1
    );
    assert_eq!(
        state["Todos"][0]["ReminderAt"],
        productivity::time(future + Duration::days(1))
    );
}
