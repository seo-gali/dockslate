use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const LINE_LIMIT: usize = 64 * 1024;
const LAYER_LIMIT: usize = 256;

#[derive(Default)]
struct Layer {
    status: String,
    current: Option<u64>,
    total: Option<u64>,
    downloaded: Option<u64>,
    download_total: Option<u64>,
}

struct State {
    reference: String,
    phase: &'static str,
    status: String,
    pending: Vec<u8>,
    oversized_line: bool,
    layers: BTreeMap<String, Layer>,
    last_emit: Instant,
    emit: Box<dyn FnMut(Value) + Send>,
}

impl State {
    fn publish(&mut self, error: Option<&str>) {
        let received: u64 = self
            .layers
            .values()
            .filter_map(|layer| layer.downloaded)
            .fold(0, u64::saturating_add);
        let total = (!self.layers.is_empty()
            && self
                .layers
                .values()
                .all(|layer| layer.download_total.is_some()))
        .then(|| {
            self.layers
                .values()
                .filter_map(|layer| layer.download_total)
                .fold(0, u64::saturating_add)
        });
        let layers: Vec<_> = self
            .layers
            .iter()
            .map(|(id, layer)| {
                json!({"id":id,"status":layer.status,"current":layer.current,"total":layer.total})
            })
            .collect();
        (self.emit)(json!({
            "reference":self.reference,"phase":self.phase,"status":self.status,
            "layers":layers,"receivedBytes":received,"totalBytes":total,"error":error
        }));
        self.last_emit = Instant::now();
    }

    fn line(&mut self) {
        let Ok(value) = serde_json::from_slice::<Value>(&self.pending) else {
            return;
        };
        let Some(status) = value["status"].as_str() else {
            return;
        };
        self.phase = "downloading";
        self.status = status.chars().take(300).collect();
        if let Some(id) = value["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control))
        {
            if self.layers.contains_key(id) || self.layers.len() < LAYER_LIMIT {
                let layer = self.layers.entry(id.into()).or_default();
                layer.status = self.status.clone();
                layer.current = value["progressDetail"]["current"].as_u64();
                layer.total = value["progressDetail"]["total"]
                    .as_u64()
                    .filter(|total| *total > 0);
                if status == "Downloading" {
                    layer.downloaded = layer.current.or(layer.downloaded);
                    layer.download_total = layer.total.or(layer.download_total);
                }
                if status == "Download complete" {
                    layer.downloaded = layer.download_total.or(layer.downloaded);
                }
            }
        }
        if self.last_emit.elapsed() >= Duration::from_millis(100) {
            self.publish(None);
        }
    }

    fn consume(&mut self, chunk: &[u8]) {
        for byte in chunk {
            if *byte == b'\n' {
                if !self.oversized_line && !self.pending.is_empty() {
                    self.line();
                }
                self.pending.clear();
                self.oversized_line = false;
            } else if self.pending.len() < LINE_LIMIT && !self.oversized_line {
                self.pending.push(*byte);
            } else {
                self.pending.clear();
                self.oversized_line = true;
            }
        }
    }
}

pub(crate) struct Progress(Arc<Mutex<State>>);

impl Progress {
    pub(crate) fn new(reference: String, emit: impl FnMut(Value) + Send + 'static) -> Self {
        let mut state = State {
            reference,
            phase: "connecting",
            status: "Connecting to the verified Docker Engine".into(),
            pending: Vec::new(),
            oversized_line: false,
            layers: BTreeMap::new(),
            last_emit: Instant::now(),
            emit: Box::new(emit),
        };
        state.publish(None);
        Self(Arc::new(Mutex::new(state)))
    }

    pub(crate) fn observer(&self) -> Box<dyn FnMut(&[u8]) + Send> {
        let state = self.0.clone();
        Box::new(move |chunk| {
            if let Ok(mut state) = state.lock() {
                state.consume(chunk);
            }
        })
    }

    pub(crate) fn phase(&self, phase: &'static str, status: &str, error: Option<&str>) {
        if let Ok(mut state) = self.0.lock() {
            state.phase = phase;
            state.status = status.chars().take(300).collect();
            state.publish(error);
        }
    }
}
