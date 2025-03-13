#!/usr/bin/env bash

set -euo pipefail

CHUNK_SIZE=1000
OUTPUT_DIR="results"
INPUT_DIR="input"
SCANNER="scan-domains-playwright.js"
DB_PATH="${OUTPUT_DIR}/results.db"

mkdir -p "$OUTPUT_DIR"

txt_files_found=false

# 1) Gather all *.txt files into a list first:
txt_files=$(ls "${INPUT_DIR}"/*.txt 2>/dev/null || true)

if [ -z "$txt_files" ]; then
  echo "No .txt files found to split. Skipping splitting step."
else
  txt_files_found=true
  for file in $txt_files; do
    # e.g., "large-domain-list.txt" => "large-domain-list"
    base="$(basename "$file" .txt)"
    echo "Splitting $file into ${CHUNK_SIZE}-line chunks..."
    split -l "$CHUNK_SIZE" -a 3 --additional-suffix=.chunk "$file" "${INPUT_DIR}/${base}_"
  done
fi


# 2) process all .chunk files

chunk_files=$(ls "${INPUT_DIR}"/*.chunk 2>/dev/null || true)
if [ -z "$chunk_files" ]; then
  echo "No .chunk files found in ${INPUT_DIR}."
else
  for chunk in $chunk_files; do
    echo "Processing chunk: $chunk"
    echo "Starting timeout command..."
    
    # Capture the timeout command's output and exit code in a subshell
    if timeout --foreground -k 5s 10m node "$SCANNER" \
      --input "$chunk" \
      --db "$DB_PATH" \
      --concurrency 40 \
      --pool-size 40 \
      --max-retries 1; then
        echo "Command succeeded"
    else
        timeout_code=$?
        echo "Command failed with: $timeout_code"
        # Continue loop if it was a timeout
        if [ $timeout_code -eq 124 ]; then
            echo "Was a timeout, continuing..."
	    rm -f "$chunk"
	    continue
        fi
        # Otherwise exit with the error code
        echo "Was not a timeout, exiting with $timeout_code"
        exit $timeout_code
    fi
    rm -f "$chunk"
  done
fi

echo "All available chunks processed. Results stored in ${DB_PATH}."

