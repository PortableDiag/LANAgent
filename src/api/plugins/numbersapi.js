import { BasePlugin } from "../core/basePlugin.js";
import axios from "axios";

export default class NumbersApiPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = "numbersapi";
    this.version = "1.0.0";
    this.description = "Random facts about numbers via NumbersAPI";
    this.commands = [
      {
        command: "fact",
        description: "Get a random fact about a number",
        usage: "fact({ number: 42 })",
        examples: ["tell me a fact about 42", "number fact"]
      }
    ];
  }

  async execute(params = {}) {
    const { action, number } = params;
    if (action === "fact") {
      const n = number || Math.floor(Math.random() * 100);
      const res = await axios.get(`http://numbersapi.com/${n}`, { timeout: 5000 });
      return { success: true, result: res.data };
    }
    return { success: false, error: `Unknown action: ${action}` };
  }

  getCommands() { return { fact: "Get a random number fact" }; }
}
