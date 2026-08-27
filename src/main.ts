import { MediaFile, WordScoreBuckets, TranscriptJSON } from "./types/media";
import "./style.css";
import "whisper-transcript-sticky";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'whisper-transcript': unknown;
    }
  }
}

// State
let cachedTranscript: TranscriptJSON | null = null;
let originalDynamicBuckets: WordScoreBuckets | null = null;
let activeBuckets: WordScoreBuckets | null = null;
let allWords: Array<{ word: string; start: number; end: number; score: number }> = [];
let isPanelVisible = false;
let isStaticEditing = false;
const WORDS_BEFORE = 3;
const WORDS_AFTER = 3;

document.addEventListener("DOMContentLoaded", () => {
  const controlsContainer = document.getElementById("controls-container");
  const transcriptContainer = document.getElementById("transcript-container");
  const transcriptWrapper = document.getElementById("transcript-wrapper");
  const scoringPanel = document.getElementById("scoring-panel");

  fetch("./config.json")
    .then((response) => response.json())
    .then((mediaFiles: MediaFile[]) => {
      const dropdown = document.createElement("select");
      dropdown.id = "audio-dropdown";

      const placeholder = document.createElement("option");
      placeholder.className = "text-black";
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = "Choose an audio file...";
      dropdown.appendChild(placeholder);

      // Filter and sort files with names
      const validMediaFiles = mediaFiles.filter((file): file is MediaFile & { name: string } =>
        typeof file.name === 'string'
      );
      validMediaFiles.sort((a, b) => a.name.localeCompare(b.name));

      validMediaFiles.forEach((file, index) => {
        const option = document.createElement("option");
        option.value = index.toString();
        option.textContent = file.name;
        dropdown.appendChild(option);
      });

      const vttButton = document.createElement("a");
      vttButton.className = "btn btn-primary btn-sm mt-2";
      vttButton.target = "_blank";
      vttButton.textContent = "Download VTT";

      // Create Details button
      const detailsButton = document.createElement("button");
      detailsButton.className = "btn btn-secondary btn-sm mt-2 details-btn";
      detailsButton.textContent = "Details";
      detailsButton.addEventListener("click", toggleDetailsPanel);

      if (controlsContainer) {
        const label = document.createElement("label");
        label.className = "block text-white text-sm font-medium mb-2";
        label.htmlFor = "audio-dropdown";
        label.textContent = "Select Audio File:";

        controlsContainer.appendChild(label);
        controlsContainer.appendChild(dropdown);
        controlsContainer.appendChild(vttButton);
        controlsContainer.appendChild(detailsButton);
      }

      let whisperElement: HTMLElement | null = null;

      const updateWhisperTranscript = async (index: number, customBuckets?: WordScoreBuckets) => {
        const selectedFile = validMediaFiles[index];
        if (!selectedFile) return;

        // Remove existing element
        if (whisperElement && transcriptContainer?.contains(whisperElement)) {
          transcriptContainer.removeChild(whisperElement);
        }

        // Fetch JSON for this file
        try {
          const response = await fetch(selectedFile.url);
          const jsonData: TranscriptJSON = await response.json();
          cachedTranscript = jsonData;

          console.log("Fetched JSON:", selectedFile.url);
          console.log("word_score_buckets:", jsonData.word_score_buckets);

          // Only store original buckets and update display on fresh load (no custom buckets)
          if (!customBuckets) {
            if (jsonData.word_score_buckets) {
              originalDynamicBuckets = { ...jsonData.word_score_buckets };
              activeBuckets = { ...jsonData.word_score_buckets }; // Set active buckets
              console.log("Stored original dynamic buckets:", originalDynamicBuckets);
              renderDynamicScores(jsonData.word_score_buckets);
              updateActiveIndicator('dynamic');

              // Enable Dynamic Apply button
              const applyDynamicBtn = document.getElementById("apply-dynamic") as HTMLButtonElement;
              if (applyDynamicBtn) applyDynamicBtn.disabled = false;
            } else {
              console.log("No word_score_buckets found in JSON, using defaults");
              originalDynamicBuckets = null;
              // Use default static thresholds so highlighting still works
              activeBuckets = { Good: 0.8, Neutral: 0.5, Bad: 0.2 };
              renderDynamicScores({ Good: 0, Neutral: 0, Bad: 0 });
              updateActiveIndicator('static');

              // Disable Dynamic Apply button since no buckets exist
              const applyDynamicBtn = document.getElementById("apply-dynamic") as HTMLButtonElement;
              if (applyDynamicBtn) applyDynamicBtn.disabled = true;
            }
          }

          // If custom buckets provided, modify the JSON for this render
          if (customBuckets) {
            jsonData.word_score_buckets = customBuckets;
            activeBuckets = customBuckets; // Update active buckets
            console.log("Using custom buckets:", customBuckets);
            // If we are applying custom buckets, we need to know if it's static or "original dynamic restoration"
            // But updateWhisperTranscript is general. We'll handle indicator update in the click handlers instead for manual applications.
            // For initial load (no customBuckets), we handled it above.
          }

          // Create blob URL to pass modified JSON
          const blob = new Blob([JSON.stringify(jsonData)], { type: 'application/json' });
          const blobUrl = URL.createObjectURL(blob);

          // Create new Whisper element
          whisperElement = document.createElement("whisper-transcript");
          whisperElement.setAttribute("audio", selectedFile.audio);
          whisperElement.setAttribute("url", blobUrl);

          // Add to container
          if (transcriptContainer) {
            transcriptContainer.innerHTML = "";
            transcriptContainer.appendChild(whisperElement);
          }

          // Extract all words for timeline feature (only on fresh load)
          if (!customBuckets && jsonData.segments) {
            allWords = [];
            for (const segment of jsonData.segments) {
              if (segment.words) {
                for (const w of segment.words) {
                  allWords.push({
                    word: w.word,
                    start: w.start,
                    end: w.end,
                    score: w.score ?? w.probability ?? 0
                  });
                }
              }
            }
            console.log(`Extracted ${allWords.length} words for timeline`);
          }

          // Set up audio time listener after a short delay to let the component render
          setTimeout(() => {
            setupAudioTimeListener();
          }, 500);

        } catch (error) {
          console.error("Error fetching transcript JSON:", error);
        }

        // Update the VTT button
        if (selectedFile.vtt) {
          vttButton.setAttribute("href", selectedFile.vtt);
          vttButton.textContent = `Download VTT - ${selectedFile.name}`;
          vttButton.classList.remove("btn-disabled");
        } else {
          vttButton.removeAttribute("href");
          vttButton.textContent = "No VTT Available";
          vttButton.classList.add("btn-disabled");
        }
      };

      // Toggle Details Panel
      function toggleDetailsPanel() {
        isPanelVisible = !isPanelVisible;

        if (scoringPanel) {
          scoringPanel.classList.toggle("visible", isPanelVisible);
        }
        if (transcriptWrapper) {
          transcriptWrapper.classList.toggle("shrunk", isPanelVisible);
        }

        detailsButton.textContent = isPanelVisible ? "Hide Details" : "Details";
      }

      function updateActiveIndicator(type: 'dynamic' | 'static') {
        const dynamicLabel = document.getElementById('dynamic-active-label');
        const staticLabel = document.getElementById('static-active-label');

        if (dynamicLabel && staticLabel) {
          if (type === 'dynamic') {
            dynamicLabel.style.display = 'inline';
            staticLabel.style.display = 'none';
          } else {
            dynamicLabel.style.display = 'none';
            staticLabel.style.display = 'inline';
          }
        }
      }

      // Render Dynamic Scores from JSON
      function renderDynamicScores(buckets: WordScoreBuckets) {
        console.log("renderDynamicScores called with:", buckets);

        const goodEl = document.getElementById("dynamic-good");
        const neutralEl = document.getElementById("dynamic-neutral");
        const badEl = document.getElementById("dynamic-bad");

        console.log("Found elements:", { goodEl, neutralEl, badEl });

        if (goodEl) goodEl.textContent = buckets.Good ? buckets.Good.toFixed(3) : 'N/A';
        if (neutralEl) neutralEl.textContent = buckets.Neutral ? buckets.Neutral.toFixed(3) : 'N/A';
        if (badEl) badEl.textContent = buckets.Bad ? buckets.Bad.toFixed(3) : 'N/A';

        console.log("Updated dynamic scores");
      }

      // Apply Dynamic Scoring - uses the original buckets from the JSON file
      document.getElementById("apply-dynamic")?.addEventListener("click", () => {
        if (originalDynamicBuckets) {
          const currentIndex = parseInt(dropdown.value);
          if (!isNaN(currentIndex)) {
            console.log("Applying original dynamic buckets:", originalDynamicBuckets);
            updateWhisperTranscript(currentIndex, originalDynamicBuckets);
            updateActiveIndicator('dynamic');
          }
        } else {
          console.log("No original dynamic buckets available");
        }
      });

      // Edit Static Scoring
      document.getElementById("edit-static")?.addEventListener("click", () => {
        isStaticEditing = !isStaticEditing;
        const inputs = document.querySelectorAll("#static-scores input");
        inputs.forEach((input) => {
          (input as HTMLInputElement).disabled = !isStaticEditing;
        });

        const editBtn = document.getElementById("edit-static");
        if (editBtn) {
          editBtn.textContent = isStaticEditing ? "Done" : "Edit";
        }
      });

      // Apply Static Scoring
      document.getElementById("apply-static")?.addEventListener("click", () => {
        const goodInput = document.getElementById("static-good") as HTMLInputElement;
        const neutralInput = document.getElementById("static-neutral") as HTMLInputElement;
        const badInput = document.getElementById("static-bad") as HTMLInputElement;

        const staticBuckets: WordScoreBuckets = {
          Good: parseFloat(goodInput?.value ?? "0.8"),
          Neutral: parseFloat(neutralInput?.value ?? "0.5"),
          Bad: parseFloat(badInput?.value ?? "0.2")
        };

        const currentIndex = parseInt(dropdown.value);
        if (!isNaN(currentIndex)) {
          updateWhisperTranscript(currentIndex, staticBuckets);
          updateActiveIndicator('static');
        }
      });


      // Update If Dropdown Is Changed
      dropdown.addEventListener("change", (event: Event) => {
        const index = parseInt((event.target as HTMLSelectElement).value);
        updateWhisperTranscript(index);
      });

      // Load the first file
      if (validMediaFiles.length > 0) {
        updateWhisperTranscript(0);
        dropdown.selectedIndex = 1; // Skip placeholder
      }

      // Setup audio time listener for word timeline
      function setupAudioTimeListener() {
        const whisperEl = document.querySelector('whisper-transcript');
        if (!whisperEl || !whisperEl.shadowRoot) {
          console.log("Whisper element not ready yet");
          return;
        }

        const mediaEl = whisperEl.shadowRoot.querySelector('whisper-media');
        if (!mediaEl || !mediaEl.shadowRoot) {
          console.log("Media element not ready yet");
          return;
        }

        const audioEl = mediaEl.shadowRoot.querySelector('audio');
        if (!audioEl) {
          console.log("Audio element not found");
          return;
        }

        console.log("Audio element found, setting up timeupdate listener");

        audioEl.addEventListener('timeupdate', () => {
          updateWordTimeline(audioEl.currentTime);
        });
      }

      // Update the word timeline based on current audio time
      function updateWordTimeline(currentTime: number) {
        const timelineWordsEl = document.getElementById('timeline-words');
        const scoreDisplayEl = document.getElementById('score-display');

        if (!timelineWordsEl || !scoreDisplayEl) return;
        if (allWords.length === 0) return;

        // Find the current word index based on time
        let currentWordIndex = -1;
        for (let i = 0; i < allWords.length; i++) {
          const word = allWords[i];
          if (currentTime >= word.start && currentTime <= word.end) {
            currentWordIndex = i;
            break;
          }
          // If we're between words, use the previous word
          if (currentTime < word.start && i > 0) {
            currentWordIndex = i - 1;
            break;
          }
        }

        // If no match found and time is past all words, use last word
        if (currentWordIndex === -1 && currentTime > 0 && allWords.length > 0) {
          const lastWord = allWords[allWords.length - 1];
          if (currentTime >= lastWord.start) {
            currentWordIndex = allWords.length - 1;
          }
        }

        // If still no match, don't update
        if (currentWordIndex === -1) return;

        // Get surrounding words
        const startIdx = Math.max(0, currentWordIndex - WORDS_BEFORE);
        const endIdx = Math.min(allWords.length - 1, currentWordIndex + WORDS_AFTER);

        // Build the timeline HTML
        let html = '';
        for (let i = startIdx; i <= endIdx; i++) {
          const word = allWords[i];
          let cssClass = 'timeline-word';

          if (i < currentWordIndex) {
            cssClass += ' before';
          } else if (i > currentWordIndex) {
            cssClass += ' after';
          } else {
            cssClass += ' current';
          }

          html += `<span class="${cssClass}">${word.word}</span>`;
        }

        timelineWordsEl.innerHTML = html;

        // Update the score display
        const currentWord = allWords[currentWordIndex];
        const score = currentWord.score;
        scoreDisplayEl.textContent = score.toFixed(3);

        // Update score color class based on thresholds
        scoreDisplayEl.className = 'score-display';
        if (activeBuckets) {
          if (score < activeBuckets.Bad) {
            scoreDisplayEl.classList.add('terrible');
          } else if (score < activeBuckets.Neutral) {
            scoreDisplayEl.classList.add('poor');
          } else if (score < activeBuckets.Good) {
            scoreDisplayEl.classList.add('mediocre');
          }
          // else it's good (default green color)
        }
      }
    })
    .catch((error: Error) => {
      console.error("Error loading media files:", error);

      // If no media to load, show error
      if (controlsContainer) {
        controlsContainer.innerHTML = `
          <div class="alert alert-error">
            <span>Error loading audio files. Please check your configuration.</span>
          </div>
        `;
      }
    });
});