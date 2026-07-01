export async function findMissingKeywordsLLM(jdText: string, resumeText: string, modelName: string): Promise<string[]> {
  const url = "http://localhost:11434/api/generate";
  
  const prompt = `You are an expert ATS optimization assistant. You are given a user's Resume and a Job Description. Your task is to identify the top 15 most important skills and keywords that are present in the Job Description but MISSING from the Resume. Return ONLY a comma-separated list of these missing words/phrases. Do not include any introductory text, markdown formatting, or bullet points. Just a single line of comma-separated words.

Job Description:
${jdText}

Resume:
${resumeText}
`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName || "qwen2.5:1.5b",
        prompt: prompt,
        stream: false,
        // Deterministic output, capped length (the answer is a short list),
        // and keep the model warm to avoid reload latency between requests.
        options: { temperature: 0, num_predict: 128 },
        keep_alive: "10m"
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API Error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const textResponse = data.response || "";
    
    // Parse the comma-separated list
    const missingWords = textResponse.split(",")
      .map((word: string) => word.trim())
      .filter((word: string) => word.length > 0);
      
    return missingWords;
  } catch (err: any) {
    if (err.message === 'Failed to fetch') {
      throw new Error("Could not connect to Ollama. Please ensure it is running with OLLAMA_ORIGINS='*'");
    }
    throw err;
  }
}
