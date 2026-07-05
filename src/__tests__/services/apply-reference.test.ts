import { describe, expect, it } from "vitest";
import {
  applyReferenceToWorkflow,
  findReferenceSlots,
} from "../../services/apply-reference.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const sampleWorkflow: WorkflowJSON = {
  "5": { class_type: "LoadImage", inputs: { image: "old.png" } },
  "6": {
    class_type: "TextEncodeQwenImageEditPlusAdvance_lrzjason",
    inputs: {
      prompt: "make it blue",
      vl_resize_image1: "old-ref.png",
      not_resize_image2: "other.png",
    },
  },
  "7": { class_type: "KSampler", inputs: { seed: 1 } },
};

describe("findReferenceSlots", () => {
  it("discovers LoadImage and Qwen encoder slots", () => {
    const slots = findReferenceSlots(sampleWorkflow);
    expect(slots.map((s) => `${s.node_id}.${s.input_name}`)).toEqual([
      "5.image",
      "6.vl_resize_image1",
      "6.not_resize_image2",
    ]);
  });
});

describe("applyReferenceToWorkflow", () => {
  it("patches primary LoadImage by default (auto role)", () => {
    const result = applyReferenceToWorkflow({
      workflow: sampleWorkflow,
      image_filename: "concept-abc.png",
    });
    expect(result.workflow["5"].inputs.image).toBe("concept-abc.png");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].previous).toBe("old.png");
  });

  it("patches Qwen vl_resize_image1 when no LoadImage primary exists", () => {
    const wf: WorkflowJSON = {
      "6": {
        class_type: "TextEncodeQwenImageEditPlusAdvance_lrzjason",
        inputs: { vl_resize_image1: "x.png" },
      },
    };
    const result = applyReferenceToWorkflow({
      workflow: wf,
      image_filename: "concept.png",
    });
    expect(result.workflow["6"].inputs.vl_resize_image1).toBe("concept.png");
  });

  it("patches explicit node/input when provided", () => {
    const result = applyReferenceToWorkflow({
      workflow: sampleWorkflow,
      image_filename: "mask.png",
      node_id: "6",
      input_name: "not_resize_image2",
    });
    expect(result.workflow["6"].inputs.not_resize_image2).toBe("mask.png");
    expect(result.workflow["5"].inputs.image).toBe("old.png");
  });

  it("rejects traversal in image_filename", () => {
    expect(() =>
      applyReferenceToWorkflow({
        workflow: sampleWorkflow,
        image_filename: "../evil.png",
      }),
    ).toThrow(/single filename/);
  });
});