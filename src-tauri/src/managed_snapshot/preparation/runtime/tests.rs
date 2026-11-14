use super::*;

fn statuses(count: usize) -> Vec<Status> {
    (0..count)
        .map(|index| Status {
            id: format!("00000000-0000-4000-8000-{index:012x}"),
            outcome: Outcome::Aborted,
        })
        .collect()
}

#[test]
fn runtime_data_status_pages_are_bounded_complete_and_use_explicit_valid_cursors() {
    let statuses = statuses(4096);
    let mut cursor = None;
    let mut collected = Vec::new();
    loop {
        let page = page(&statuses, cursor.as_deref()).unwrap();
        assert!(page.statuses.len() <= 32);
        collected.extend(page.statuses.iter().map(|status| status.id.clone()));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        collected,
        statuses
            .iter()
            .map(|status| status.id.clone())
            .collect::<Vec<_>>()
    );
    assert!(page(&statuses, Some("../../not-a-record")).is_err());
    assert!(page(&[], None).unwrap().statuses.is_empty());
}

#[test]
fn runtime_data_status_page_with_full_receipts_fits_the_native_frame_limit() {
    let statuses = statuses(32)
        .into_iter()
        .map(|status| Status {
            id: status.id.clone(),
            outcome: Outcome::Prepared {
                receipt: Receipt {
                    format: "dustdesk-runtime-data-prepared".into(),
                    version: 1,
                    id: status.id,
                    preparation_id: Uuid::new_v4().to_string(),
                    snapshot_receipt_sha256: "a".repeat(64),
                    inventory_sha256: "b".repeat(64),
                    destination_identity: FileIdentity {
                        volume: u32::MAX,
                        index: u64::MAX,
                    },
                    workspace_sha256: "c".repeat(64),
                    files: managed_snapshot::MAX_ENTRIES - 1,
                    directories: 1,
                    total_bytes: managed_snapshot::MAX_TOTAL_BYTES,
                    production_ready: false,
                    migration_complete: false,
                },
            },
        })
        .collect::<Vec<_>>();
    let page = page(&statuses, None).unwrap();
    assert!(serde_json::to_vec(&page).unwrap().len() < 60 * 1024);
}
