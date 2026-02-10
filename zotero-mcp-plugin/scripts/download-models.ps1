# Download Models Script for Zotero MCP Semantic Search
# Run this script from the project root directory

$ErrorActionPreference = "Stop"

$ADDON_DIR = Join-Path $PSScriptRoot "..\addon\content"
$LIBS_DIR = Join-Path $ADDON_DIR "libs"
$MODELS_DIR = Join-Path $ADDON_DIR "models"

Write-Host "=== Zotero MCP Semantic Search Model Setup ===" -ForegroundColor Cyan
Write-Host ""

# Create directories
New-Item -ItemType Directory -Force -Path $LIBS_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null

# ============ Step 1: Download Transformers.js ============
Write-Host "[1/3] Downloading Transformers.js..." -ForegroundColor Yellow

$TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js"
$TRANSFORMERS_PATH = Join-Path $LIBS_DIR "transformers.min.js"

try {
    Invoke-WebRequest -Uri $TRANSFORMERS_URL -OutFile $TRANSFORMERS_PATH
    Write-Host "  Downloaded transformers.min.js" -ForegroundColor Green
} catch {
    Write-Host "  Failed to download Transformers.js: $_" -ForegroundColor Red
    exit 1
}

# ============ Step 2: Download ONNX Runtime WASM ============
Write-Host "[2/3] Downloading ONNX Runtime WASM files..." -ForegroundColor Yellow

$ONNX_BASE_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist"
$ONNX_FILES = @(
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd.wasm",
    "ort-wasm.wasm"
)

foreach ($file in $ONNX_FILES) {
    $url = "$ONNX_BASE_URL/$file"
    $path = Join-Path $LIBS_DIR $file
    try {
        Invoke-WebRequest -Uri $url -OutFile $path
        Write-Host "  Downloaded $file" -ForegroundColor Green
    } catch {
        Write-Host "  Warning: Failed to download $file" -ForegroundColor Yellow
    }
}

# ============ Step 3: Download BGE Models ============
Write-Host "[3/3] Downloading BGE Embedding Models..." -ForegroundColor Yellow
Write-Host "  This may take a while (~50MB total)..." -ForegroundColor Gray

# Model configurations
$MODELS = @(
    @{
        Name = "bge-small-zh-v1.5"
        Repo = "Xenova/bge-small-zh-v1.5"
        Files = @(
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "onnx/model_quantized.onnx"
        )
    },
    @{
        Name = "bge-small-en-v1.5"
        Repo = "Xenova/bge-small-en-v1.5"
        Files = @(
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "onnx/model_quantized.onnx"
        )
    }
)

$HF_BASE_URL = "https://huggingface.co"

foreach ($model in $MODELS) {
    $modelDir = Join-Path $MODELS_DIR $model.Name
    $onnxDir = Join-Path $modelDir "onnx"

    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    New-Item -ItemType Directory -Force -Path $onnxDir | Out-Null

    Write-Host "  Downloading $($model.Name)..." -ForegroundColor Cyan

    foreach ($file in $model.Files) {
        $url = "$HF_BASE_URL/$($model.Repo)/resolve/main/$file"
        $localPath = Join-Path $modelDir $file

        # Ensure directory exists
        $dir = Split-Path $localPath -Parent
        New-Item -ItemType Directory -Force -Path $dir | Out-Null

        try {
            Write-Host "    Downloading $file..." -ForegroundColor Gray
            Invoke-WebRequest -Uri $url -OutFile $localPath
        } catch {
            Write-Host "    Failed to download $file : $_" -ForegroundColor Red
        }
    }
}

# ============ Summary ============
Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Files downloaded to:" -ForegroundColor White
Write-Host "  Libraries: $LIBS_DIR" -ForegroundColor Gray
Write-Host "  Models: $MODELS_DIR" -ForegroundColor Gray
Write-Host ""

# Show file sizes
Write-Host "Model sizes:" -ForegroundColor White
Get-ChildItem -Path $MODELS_DIR -Recurse -File |
    Group-Object { Split-Path (Split-Path $_.FullName -Parent) -Leaf } |
    ForEach-Object {
        $size = ($_.Group | Measure-Object -Property Length -Sum).Sum / 1MB
        Write-Host "  $($_.Name): $([math]::Round($size, 2)) MB" -ForegroundColor Gray
    }

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Rebuild the plugin: npm run build" -ForegroundColor Gray
Write-Host "  2. Reload the plugin in Zotero" -ForegroundColor Gray
Write-Host "  3. Use 'build_semantic_index' to index your library" -ForegroundColor Gray
Write-Host "  4. Use 'semantic_search' to search!" -ForegroundColor Gray
