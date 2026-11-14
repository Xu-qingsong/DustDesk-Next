//! Development-only bridge for tests/tauri-lan-compat.mjs. Never included in
//! the desktop executable, and never receives production paths from the UI.
use dustdesk_tauri::lan::{
    protocol::{self, Discovery, Manifest, OfferReply},
    storage::{Identity, State},
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("usage: lan-compat fixture.json new-output-directory".into());
    }
    let input: Value = serde_json::from_slice(&fs::read(&args[0])?)?;
    let output = PathBuf::from(&args[1]);
    fs::create_dir(&output)?;
    let mut manifests = Vec::new();
    for case in input["manifests"]
        .as_array()
        .ok_or("manifest fixtures missing")?
    {
        let result = Manifest::parse(
            case["json"]
                .as_str()
                .ok_or("manifest JSON missing")?
                .as_bytes(),
        );
        manifests.push(match result {
            Ok(manifest) => {
                json!({"valid":true,"total":manifest.total()?,"public":manifest.public()})
            }
            Err(error) => json!({"valid":false,"error":error}),
        });
    }
    let pairs = input["pairs"]
        .as_array()
        .ok_or("pair fixtures missing")?
        .iter()
        .map(|pair| protocol::pairing_code(pair[0].as_str().unwrap(), pair[1].as_str().unwrap()))
        .collect::<Result<Vec<_>, _>>()?;
    let addresses = input["addresses"]
        .as_array()
        .ok_or("address fixtures missing")?
        .iter()
        .map(|value| protocol::valid_address(value.as_str().unwrap()))
        .collect::<Vec<_>>();
    let discoveries = input["discoveries"]
        .as_array()
        .ok_or("discovery fixtures missing")?
        .iter()
        .map(|case| {
            Discovery::parse(
                case["json"].as_str().unwrap().as_bytes(),
                case["remote"].as_str().unwrap(),
                "self",
            )
            .is_ok()
        })
        .collect::<Vec<_>>();
    let mut states = Vec::new();
    let mut identities = Vec::new();
    for (index, root) in input["roots"]
        .as_array()
        .ok_or("state roots missing")?
        .iter()
        .enumerate()
    {
        let root = PathBuf::from(root.as_str().ok_or("state root missing")?);
        let identity = Identity::load(&root)?.ok_or("identity missing")?;
        assert_eq!(
            protocol::fingerprint(identity.certified_key().cert[0].as_ref()),
            identity.fingerprint
        );
        identities.push(json!({"id":identity.id,"fingerprint":identity.fingerprint}));
        let state = State::load(&root)?;
        let target = output.join(format!("state-{index}.json"));
        fs::write(&target, state.encode_for_restart()?)?;
        states.push(json!({"tasks":state.tasks.len(),"trusted":state.trusted.len(),"enabled":state.enabled}));
    }
    let mut identity_faults = Vec::new();
    for root in input["identityFaults"]
        .as_array()
        .ok_or("identity fault roots missing")?
    {
        let root = PathBuf::from(root.as_str().unwrap());
        let before = fs::read(root.join("identity.json"))?;
        identity_faults.push(Identity::load(&root).is_err());
        assert_eq!(before, fs::read(root.join("identity.json"))?);
    }
    let mut offers = Vec::new();
    for case in input["offers"].as_array().ok_or("offer fixtures missing")? {
        let manifest = Manifest::parse(case["manifest"].as_str().unwrap().as_bytes())?;
        let offer = serde_json::from_value::<OfferReply>(case["offer"].clone());
        offers.push(offer.is_ok_and(|offer| offer.validate(&manifest).is_ok()));
    }
    let mut prefixes = Vec::new();
    for case in input["prefixes"]
        .as_array()
        .ok_or("prefix fixtures missing")?
    {
        prefixes.push(protocol::hash_prefix(
            fs::File::open(case["path"].as_str().unwrap())?,
            case["size"].as_u64().unwrap(),
        )?);
    }
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(
            &json!({"manifests":manifests,"pairs":pairs,"addresses":addresses,"discoveries":discoveries,"states":states,"identities":identities,"identityFaults":identity_faults,"offers":offers,"prefixes":prefixes}),
        )?,
    )?;
    println!("Rust LAN compatibility fixtures completed");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("LAN compatibility fixture failed: {error}");
        std::process::exit(1);
    }
}
