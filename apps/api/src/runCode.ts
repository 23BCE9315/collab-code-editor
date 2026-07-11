import express from "express";
import axios from "axios";

const router = express.Router();

const JUDGE0_API = "https://ce.judge0.com/submissions";

router.post("/run", async (req, res) => {
  try {
    const { code, languageId } = req.body;

    if (!code || !languageId) {
      return res.status(400).json({
        error: "code and languageId are required",
      });
    }

    const response = await axios.post(
      `${JUDGE0_API}?base64_encoded=false&wait=true`,
      {
        source_code: code,
        language_id: languageId,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data;

    return res.json({
      stdout: data.stdout,
      stderr: data.stderr,
      compile_output: data.compile_output,
      message: data.message,
      status: data.status?.description,
      output:
        data.stdout ||
        data.stderr ||
        data.compile_output ||
        data.message ||
        data.status?.description ||
        "No output",
    });
  } catch (error: any) {
    console.error("Judge0 error:", error?.response?.data || error.message);

    return res.status(500).json({
      error:
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Execution failed",
    });
  }
});

export default router;