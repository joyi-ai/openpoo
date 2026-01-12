//! Speech-to-text module using Parakeet TDT 0.6B ONNX model.
//!
//! This module provides local, offline speech recognition using NVIDIA's
//! Parakeet TDT model running via ONNX Runtime.

use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::TensorRef,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

const MODEL_NAME: &str = "parakeet-tdt-0.6b-v3";
const HF_BASE_URL: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";

/// Model files required for inference
const MODEL_FILES: &[&str] = &[
    "nemo128.onnx",
    "encoder-model.onnx",
    "encoder-model.onnx.data", // ~2.4GB weights file
    "decoder_joint-model.onnx",
    "vocab.txt",
    "config.json",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ModelStatus {
    NotDownloaded,
    Downloading { progress: f32 },
    Ready,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub model_status: ModelStatus,
    pub is_recording: bool,
}

/// State for the STT engine
pub struct SttState {
    /// Audio buffer for accumulating samples during recording
    audio_buffer: Vec<f32>,
    /// Whether currently recording
    is_recording: bool,
    /// ONNX session for the preprocessor (nemo128)
    preprocessor_session: Option<Arc<Mutex<Session>>>,
    /// ONNX session for the encoder
    encoder_session: Option<Arc<Mutex<Session>>>,
    /// ONNX session for the decoder
    decoder_session: Option<Arc<Mutex<Session>>>,
    /// Vocabulary: token ID -> string
    vocab: Arc<HashMap<i64, String>>,
    /// Vocabulary size
    vocab_size: usize,
    /// Blank token index
    blank_idx: i64,
    /// Model status
    model_status: ModelStatus,
    /// Path to model directory
    model_dir: PathBuf,
}

impl SttState {
    pub fn new(model_dir: PathBuf) -> Self {
        let mut state = Self {
            audio_buffer: Vec::new(),
            is_recording: false,
            preprocessor_session: None,
            encoder_session: None,
            decoder_session: None,
            vocab: Arc::new(HashMap::new()),
            vocab_size: 0,
            blank_idx: 0,
            model_status: ModelStatus::NotDownloaded,
            model_dir,
        };

        // If models are already downloaded, load them
        if Self::are_models_downloaded(&state.model_dir) {
            if let Err(e) = state.load_models() {
                state.model_status = ModelStatus::Error { message: e };
            }
        }

        state
    }

    fn are_models_downloaded(model_dir: &PathBuf) -> bool {
        MODEL_FILES.iter().all(|file| model_dir.join(file).exists())
    }

    pub fn get_status(&self) -> SttStatus {
        SttStatus {
            model_status: self.model_status.clone(),
            is_recording: self.is_recording,
        }
    }

    pub fn start_recording(&mut self) -> Result<(), String> {
        if !matches!(self.model_status, ModelStatus::Ready) {
            return Err("Model not ready. Please download the model first.".to_string());
        }
        self.audio_buffer.clear();
        self.is_recording = true;
        Ok(())
    }

    pub fn push_audio(&mut self, samples: Vec<f32>) -> Result<(), String> {
        if !self.is_recording {
            return Err("Not recording".to_string());
        }
        self.audio_buffer.extend(samples);
        Ok(())
    }

    pub fn stop_recording(&mut self) -> Vec<f32> {
        self.is_recording = false;
        std::mem::take(&mut self.audio_buffer)
    }

    fn load_vocab(model_dir: &PathBuf) -> Result<(Arc<HashMap<i64, String>>, usize, i64), String> {
        let vocab_path = model_dir.join("vocab.txt");
        let content = std::fs::read_to_string(&vocab_path)
            .map_err(|e| format!("Failed to read vocab: {}", e))?;

        let mut vocab = HashMap::new();
        let mut blank_idx = 0;
        for line in content.lines() {
            let parts: Vec<&str> = line.trim().split(' ').collect();
            if parts.len() >= 2 {
                let token = parts[0].replace('\u{2581}', " "); // Replace SentencePiece space marker
                let id: i64 = parts[1]
                    .parse()
                    .map_err(|_| format!("Invalid vocab ID: {}", parts[1]))?;
                if parts[0] == "<blk>" {
                    blank_idx = id;
                }
                vocab.insert(id, token);
            }
        }
        let vocab_size = vocab.len();
        Ok((Arc::new(vocab), vocab_size, blank_idx))
    }

    fn build_models(model_dir: &PathBuf) -> Result<LoadedModels, String> {
        if !Self::are_models_downloaded(model_dir) {
            return Err("Models not downloaded".to_string());
        }

        let (vocab, vocab_size, blank_idx) = Self::load_vocab(model_dir)?;

        let preprocessor_path = model_dir.join("nemo128.onnx");
        let encoder_path = model_dir.join("encoder-model.onnx");
        let decoder_path = model_dir.join("decoder_joint-model.onnx");

        // Initialize ONNX Runtime
        ort::init()
            .with_name("opencode-stt")
            .commit()
            .map_err(|e| format!("Failed to initialize ONNX Runtime: {}", e))?;

        // Load preprocessor session
        let preprocessor_session = Session::builder()
            .map_err(|e| format!("Failed to create preprocessor session builder: {}", e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("Failed to set optimization level: {}", e))?
            .with_intra_threads(4)
            .map_err(|e| format!("Failed to set intra threads: {}", e))?
            .commit_from_file(&preprocessor_path)
            .map_err(|e| format!("Failed to load preprocessor model: {}", e))?;

        // Load encoder session
        let encoder_session = Session::builder()
            .map_err(|e| format!("Failed to create encoder session builder: {}", e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("Failed to set optimization level: {}", e))?
            .with_intra_threads(4)
            .map_err(|e| format!("Failed to set intra threads: {}", e))?
            .commit_from_file(&encoder_path)
            .map_err(|e| format!("Failed to load encoder model: {}", e))?;

        // Load decoder session
        let decoder_session = Session::builder()
            .map_err(|e| format!("Failed to create decoder session builder: {}", e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("Failed to set optimization level: {}", e))?
            .with_intra_threads(4)
            .map_err(|e| format!("Failed to set intra threads: {}", e))?
            .commit_from_file(&decoder_path)
            .map_err(|e| format!("Failed to load decoder model: {}", e))?;

        Ok(LoadedModels {
            preprocessor: Arc::new(Mutex::new(preprocessor_session)),
            encoder: Arc::new(Mutex::new(encoder_session)),
            decoder: Arc::new(Mutex::new(decoder_session)),
            vocab,
            vocab_size,
            blank_idx,
        })
    }

    fn apply_models(&mut self, models: LoadedModels) {
        self.preprocessor_session = Some(models.preprocessor);
        self.encoder_session = Some(models.encoder);
        self.decoder_session = Some(models.decoder);
        self.vocab = models.vocab;
        self.vocab_size = models.vocab_size;
        self.blank_idx = models.blank_idx;
        self.model_status = ModelStatus::Ready;
    }

    pub fn load_models(&mut self) -> Result<(), String> {
        let models = Self::build_models(&self.model_dir)?;
        self.apply_models(models);
        Ok(())
    }

    pub fn inference(&self) -> Result<SttInference, String> {
        let preprocessor = self
            .preprocessor_session
            .as_ref()
            .ok_or("Preprocessor not loaded")?
            .clone();
        let encoder = self
            .encoder_session
            .as_ref()
            .ok_or("Encoder not loaded")?
            .clone();
        let decoder = self
            .decoder_session
            .as_ref()
            .ok_or("Decoder not loaded")?
            .clone();

        Ok(SttInference {
            preprocessor,
            encoder,
            decoder,
            vocab: self.vocab.clone(),
            vocab_size: self.vocab_size,
            blank_idx: self.blank_idx,
        })
    }
}

struct LoadedModels {
    preprocessor: Arc<Mutex<Session>>,
    encoder: Arc<Mutex<Session>>,
    decoder: Arc<Mutex<Session>>,
    vocab: Arc<HashMap<i64, String>>,
    vocab_size: usize,
    blank_idx: i64,
}

pub struct SttInference {
    preprocessor: Arc<Mutex<Session>>,
    encoder: Arc<Mutex<Session>>,
    decoder: Arc<Mutex<Session>>,
    vocab: Arc<HashMap<i64, String>>,
    vocab_size: usize,
    blank_idx: i64,
}

impl SttInference {
    pub fn transcribe(&self, audio: &[f32]) -> Result<String, String> {
        if audio.is_empty() {
            return Ok(String::new());
        }

        // Step 1: Preprocess audio to mel features using nemo128.onnx
        // Input: waveforms [batch, samples], waveforms_lens [batch]
        // Output: features [batch, frames, 128], features_lens [batch]
        let audio_len = audio.len() as i64;
        let waveforms = ndarray::ArrayView2::from_shape((1, audio.len()), audio)
            .map_err(|e| format!("Failed to create waveforms array: {}", e))?;
        let waveforms_lens = ndarray::arr1(&[audio_len]);

        // Create input tensors
        let waveforms_tensor = TensorRef::from_array_view(waveforms)
            .map_err(|e| format!("Failed to create waveforms tensor: {}", e))?;
        let waveforms_lens_tensor = TensorRef::from_array_view(waveforms_lens.view())
            .map_err(|e| format!("Failed to create waveforms_lens tensor: {}", e))?;

        let mut preprocessor = self
            .preprocessor
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let preprocessor_outputs = preprocessor
            .run(ort::inputs![
                "waveforms" => waveforms_tensor,
                "waveforms_lens" => waveforms_lens_tensor
            ])
            .map_err(|e| format!("Failed to run preprocessor: {}", e))?;

        let features_data = preprocessor_outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract features: {}", e))?;
        let features_lens_data = preprocessor_outputs[1]
            .try_extract_tensor::<i64>()
            .map_err(|e| format!("Failed to extract features_lens: {}", e))?;

        // Reconstruct arrays from shape and data
        let features_shape: Vec<usize> = features_data.0.iter().map(|&x| x as usize).collect();
        let features = ndarray::ArrayViewD::from_shape(features_shape.clone(), features_data.1)
            .map_err(|e| format!("Failed to create features array: {}", e))?;
        let features_lens = ndarray::ArrayView1::from(features_lens_data.1);

        // Step 2: Encode features
        let features_tensor = TensorRef::from_array_view(features)
            .map_err(|e| format!("Failed to create features tensor: {}", e))?;
        let features_lens_tensor = TensorRef::from_array_view(features_lens)
            .map_err(|e| format!("Failed to create features_lens tensor: {}", e))?;

        let mut encoder = self.encoder.lock().map_err(|e| format!("Lock error: {}", e))?;
        let encoder_outputs = encoder
            .run(ort::inputs![
                "audio_signal" => features_tensor,
                "length" => features_lens_tensor
            ])
            .map_err(|e| format!("Failed to run encoder: {}", e))?;

        let encoder_out_data = encoder_outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract encoder outputs: {}", e))?;
        let encoder_lens_data = encoder_outputs[1]
            .try_extract_tensor::<i64>()
            .map_err(|e| format!("Failed to extract encoded_lengths: {}", e))?;

        let encoder_shape: Vec<usize> = encoder_out_data.0.iter().map(|&x| x as usize).collect();
        let encoder_out = ndarray::ArrayViewD::from_shape(encoder_shape.clone(), encoder_out_data.1)
            .map_err(|e| format!("Failed to create encoder array: {}", e))?;
        let encoder_lens = ndarray::ArrayView1::from(encoder_lens_data.1);

        // Get encoder output shape - [batch, dim, frames]
        let encoded_dim = encoder_shape[1];
        let num_frames = encoder_shape[2];

        // Step 3: TDT Decoding
        // Initialize LSTM hidden states
        // Parakeet TDT uses 2 LSTM layers with hidden_size=640
        // State shape: [num_layers, batch_size, hidden_size]
        const NUM_LSTM_LAYERS: usize = 2;
        const LSTM_HIDDEN_SIZE: usize = 640;

        let mut state1 = ndarray::Array3::<f32>::zeros((NUM_LSTM_LAYERS, 1, LSTM_HIDDEN_SIZE));
        let mut state2 = ndarray::Array3::<f32>::zeros((NUM_LSTM_LAYERS, 1, LSTM_HIDDEN_SIZE));

        let mut tokens: Vec<i64> = Vec::new();
        let mut t = 0usize;
        let max_tokens_per_step = 10;
        let mut emitted_tokens = 0;
        let encoded_len = encoder_lens[0] as usize;

        let mut encoder_frame = ndarray::Array3::<f32>::zeros((1, encoded_dim, 1));
        let mut targets = ndarray::Array2::<i32>::zeros((1, 1));
        let target_length = ndarray::arr1(&[1i32]);
        let mut decoder = self.decoder.lock().map_err(|e| format!("Lock error: {}", e))?;

        while t < encoded_len && t < num_frames {
            // Get encoder output at frame t: shape [1, dim, 1]
            {
                let encoder_frame_slice = encoder_frame
                    .as_slice_mut()
                    .ok_or("Failed to access encoder frame slice")?;
                for d in 0..encoded_dim {
                    encoder_frame_slice[d] = encoder_out[[0, d, t]];
                }
            }

            let prev_token = if tokens.is_empty() {
                self.blank_idx as i32
            } else {
                tokens[tokens.len() - 1] as i32
            };
            targets[[0, 0]] = prev_token;

            // Create tensors for decoder
            let encoder_frame_tensor = TensorRef::from_array_view(encoder_frame.view())
                .map_err(|e| format!("Failed to create encoder_frame tensor: {}", e))?;
            let targets_tensor = TensorRef::from_array_view(targets.view())
                .map_err(|e| format!("Failed to create targets tensor: {}", e))?;
            let target_length_tensor = TensorRef::from_array_view(target_length.view())
                .map_err(|e| format!("Failed to create target_length tensor: {}", e))?;
            let state1_tensor = TensorRef::from_array_view(state1.view())
                .map_err(|e| format!("Failed to create state1 tensor: {}", e))?;
            let state2_tensor = TensorRef::from_array_view(state2.view())
                .map_err(|e| format!("Failed to create state2 tensor: {}", e))?;

            let decoder_outputs = decoder
                .run(ort::inputs![
                    "encoder_outputs" => encoder_frame_tensor,
                    "targets" => targets_tensor,
                    "target_length" => target_length_tensor,
                    "input_states_1" => state1_tensor,
                    "input_states_2" => state2_tensor
                ])
                .map_err(|e| format!("Failed to run decoder: {}", e))?;

            // Access outputs by name to ensure correct order
            let outputs_data = decoder_outputs["outputs"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("Failed to extract decoder outputs: {}", e))?;
            let new_state1_data = decoder_outputs["output_states_1"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("Failed to extract state1: {}", e))?;
            let new_state2_data = decoder_outputs["output_states_2"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("Failed to extract state2: {}", e))?;

            let outputs_flat: &[f32] = outputs_data.1;

            // TDT: first vocab_size elements are token logits, rest are duration info
            let token_logits = &outputs_flat[..self.vocab_size];
            let duration_logits = &outputs_flat[self.vocab_size..];

            // Get best token
            let token = token_logits
                .iter()
                .enumerate()
                .max_by(|(_, a): &(usize, &f32), (_, b): &(usize, &f32)| {
                    a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i as i64)
                .unwrap_or(self.blank_idx);

            // Get step from duration logits (TDT specific)
            let step = if duration_logits.is_empty() {
                0
            } else {
                duration_logits
                    .iter()
                    .enumerate()
                    .max_by(|(_, a): &(usize, &f32), (_, b): &(usize, &f32)| {
                        a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .map(|(i, _)| i)
                    .unwrap_or(0)
            };

            if token != self.blank_idx {
                // Update state only when emitting a token
                let state1_slice = state1
                    .as_slice_mut()
                    .ok_or("Failed to access state1 slice")?;
                if state1_slice.len() != new_state1_data.1.len() {
                    return Err("State1 size mismatch".to_string());
                }
                state1_slice.copy_from_slice(new_state1_data.1);

                let state2_slice = state2
                    .as_slice_mut()
                    .ok_or("Failed to access state2 slice")?;
                if state2_slice.len() != new_state2_data.1.len() {
                    return Err("State2 size mismatch".to_string());
                }
                state2_slice.copy_from_slice(new_state2_data.1);

                tokens.push(token);
                emitted_tokens += 1;
            }

            // Advance based on TDT step or blank/max tokens
            if step > 0 {
                t += step;
                emitted_tokens = 0;
                continue;
            }
            if token == self.blank_idx || emitted_tokens >= max_tokens_per_step {
                t += 1;
                emitted_tokens = 0;
            }
        }

        // Decode tokens to text
        let mut text = String::new();
        for token_id in tokens {
            if let Some(token_str) = self.vocab.get(&token_id) {
                text.push_str(token_str);
            }
        }

        // Clean up whitespace (SentencePiece style)
        let text = text.trim().split_whitespace().collect::<Vec<_>>().join(" ");

        Ok(text)
    }
}

pub type SharedSttState = Arc<Mutex<SttState>>;

/// Get the model directory path
pub fn get_model_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .resolve(
            format!("models/{}", MODEL_NAME),
            BaseDirectory::AppLocalData,
        )
        .expect("Failed to resolve model directory")
}

/// Initialize STT state
pub fn init_stt_state(app: &AppHandle) -> SharedSttState {
    let model_dir = get_model_dir(app);
    Arc::new(Mutex::new(SttState::new(model_dir)))
}

/// Download a single model file with streaming (avoids loading entire file into memory)
async fn download_file(client: &reqwest::Client, url: &str, path: &PathBuf) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download {}: HTTP {}",
            url,
            response.status()
        ));
    }

    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;

    Ok(())
}

/// Download all model files
pub async fn download_models(app: AppHandle) -> Result<(), String> {
    // Check if models are already loaded - can't overwrite memory-mapped files
    {
        let state = app.state::<SharedSttState>();
        let state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
        if matches!(state.model_status, ModelStatus::Ready) && state.preprocessor_session.is_some() {
            return Ok(());
        }
    }

    let model_dir = get_model_dir(&app);

    // Create model directory
    std::fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model directory: {}", e))?;

    // Update state to downloading
    {
        let state = app.state::<SharedSttState>();
        let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
        state.model_status = ModelStatus::Downloading { progress: 0.0 };
    }

    let client = reqwest::Client::new();

    let total_files = MODEL_FILES.len();
    let mut downloaded = 0;

    // Download all model files
    for file in MODEL_FILES.iter() {
        let url = format!("{}/{}", HF_BASE_URL, file);
        let path = model_dir.join(file);

        // Emit progress
        let progress = (downloaded as f32) / (total_files as f32);
        app.emit("stt:download-progress", progress)
            .map_err(|e| format!("Failed to emit progress: {}", e))?;

        {
            let state = app.state::<SharedSttState>();
            let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
            state.model_status = ModelStatus::Downloading { progress };
        }

        download_file(&client, &url, &path).await?;
        downloaded += 1;
    }

    // Emit completion
    app.emit("stt:download-progress", 1.0)
        .map_err(|e| format!("Failed to emit progress: {}", e))?;

    // Load models off-lock
    let model_dir_for_load = model_dir.clone();
    let models = tokio::task::spawn_blocking(move || SttState::build_models(&model_dir_for_load))
        .await
        .map_err(|e| format!("Failed to load models: {}", e))??;

    // Update state to ready
    {
        let state = app.state::<SharedSttState>();
        let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;
        state.model_dir = model_dir;
        state.apply_models(models);
    }

    Ok(())
}
