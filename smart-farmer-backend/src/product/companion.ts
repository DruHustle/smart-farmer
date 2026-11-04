import { ApiError, manageRoles, type Context } from "../context.js";
import { reportSummary } from "./finance.js";
export async function companionSnapshot(
  ctx: Context,
  farmId: string,
  actor: string,
  projectId: string,
) {
  const p = (
    await ctx.db.query("SELECT * FROM projects WHERE farm_id=$1 AND id=$2", [
      farmId,
      projectId,
    ])
  ).rows[0];
  if (!p) throw new ApiError("project_not_found", 404);
  const financial = await ctx.member(farmId, actor, manageRoles),
    language = (
      await ctx.db.query("SELECT language FROM users WHERE id=$1", [actor])
    ).rows[0].language as "sn" | "nd";
  const labels = {
    sn: {
      details:
        "Zadzisa mashoko echirongwa asingazivikanwi kana wawana uchapupu.",
      readiness:
        "Nyora zvaongororwa kuti munda kana nzvimbo yemhuka yagadzirira.",
      plan: "Ongorora hurongwa hwakarongwa usati wabvumira mabasa.",
      late: "Ongorora basa rapfuura nguva uye nyora chikonzero kana zuva richichinja.",
      incident: "Tevera dambudziko rakanyorwa uye nyora zvawaita.",
      source: "Wedzera gwaro rine kwakabva mashoko nezuva raro.",
      photo:
        "Kana zvichibatsira, isa mufananidzo wezvakaonekwa pamwe nezviyero zvine kwakabva mashoko.",
    },
    nd: {
      details: "Gcwalisa ulwazi lohlelo olungaziwayo nxa ubufakazi bukhona.",
      readiness:
        "Bhala ukuhlolwa kokulungela komhlabathi kumbe indawo yezifuyo.",
      plan: "Hlola uhlelo oluphakanyisiweyo ungakavumi imisebenzi.",
      late: "Hlola umsebenzi osudlulile isikhathi ubhale isizatho sokutshintsha ilanga.",
      incident: "Landela udaba olubhaliweyo ubhale okwenziweyo.",
      source: "Faka umbhalo olomthombo welanga lawo.",
      photo:
        "Nxa kunceda, faka umfanekiso wokubonileyo lezilinganiso ezilomthombo.",
    },
  }[language];
  const nextTasks = (
    await ctx.db.query(
      "SELECT id,title,instructions,due_at,status,assignee_id,required_evidence,version FROM tasks WHERE farm_id=$1 AND project_id=$2 AND status NOT IN('completed','cancelled') ORDER BY due_at NULLS LAST,id LIMIT 20",
      [farmId, projectId],
    )
  ).rows;
  const records = (
    await ctx.db.query(
      "SELECT * FROM project_records WHERE farm_id=$1 AND project_id=$2 ORDER BY observed_at DESC,id DESC LIMIT 20",
      [farmId, projectId],
    )
  ).rows;
  const readiness =
    (
      await ctx.db.query(
        "SELECT * FROM project_records WHERE farm_id=$1 AND project_id=$2 AND type='readiness' ORDER BY observed_at DESC,id DESC LIMIT 1",
        [farmId, projectId],
      )
    ).rows[0] ?? null;
  const assessment =
    (
      await ctx.db.query(
        "SELECT * FROM project_records WHERE farm_id=$1 AND project_id=$2 AND type='assessment' ORDER BY observed_at DESC,id DESC LIMIT 1",
        [farmId, projectId],
      )
    ).rows[0] ?? null;
  const plans = (
    await ctx.db.query(
      "SELECT * FROM project_plans WHERE farm_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20",
      [farmId, projectId],
    )
  ).rows;
  const templates = (
    await ctx.db.query(
      "SELECT id,name,enterprise_type,source,source_date,version,language,steps FROM task_templates WHERE farm_id=$1 AND enterprise_type=$2 ORDER BY (language=$3) DESC,updated_at DESC,id LIMIT 20",
      [farmId, p.enterprise_type, language],
    )
  ).rows;
  const references = (
    await ctx.db.query(
      "SELECT id,title,source_url,published_on,version,language,reviewed_by FROM reference_material WHERE farm_id=$1 ORDER BY created_at DESC,id LIMIT 20",
      [farmId],
    )
  ).rows;
  const incidents = (
    await ctx.db.query(
      "SELECT id,title,severity,status,assignee_id,note FROM incidents WHERE farm_id=$1 AND project_id=$2 AND status<>'resolved' ORDER BY created_at DESC LIMIT 10",
      [farmId, projectId],
    )
  ).rows;
  const comparisons = (
    await ctx.db.query(
      "SELECT * FROM crop_comparisons WHERE farm_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 5",
      [farmId, projectId],
    )
  ).rows;
  if (!financial)
    for (const c of comparisons) {
      delete c.budget;
      delete c.currency;
      c.candidates = c.candidates.map(
        ({ estimatedCost, currency, score, reasons, ...candidate }: any) => ({
          ...candidate,
          reasons: reasons.filter((r: string) => !r.includes("budget")),
        }),
      );
    }
  const missingFields =
    p.enterprise_type === "crop"
      ? [
          "planting_date",
          "variety",
          "area_ha",
          "stage",
          "objective",
          "location_id",
        ].filter((k) => p[k] === null)
      : ["as_of_date", "current_count", "stage", "location_id"].filter(
          (k) => p[k] === null,
        );
  const nextActions: any[] = [];
  if (missingFields.length)
    nextActions.push({
      code: "complete_project_details",
      title: labels.details,
      missingFields,
    });
  if (!readiness)
    nextActions.push({ code: "record_readiness", title: labels.readiness });
  for (const plan of plans.filter((p) => p.status === "draft"))
    nextActions.push({
      code: "review_draft_plan",
      title: labels.plan,
      planId: plan.id,
      version: plan.version,
    });
  for (const task of nextTasks.filter(
    (t) => t.due_at && new Date(t.due_at) < new Date(),
  ))
    nextActions.push({
      code: "review_overdue_task",
      title: labels.late,
      taskId: task.id,
    });
  for (const incident of incidents)
    nextActions.push({
      code: "review_incident",
      title: labels.incident,
      incidentId: incident.id,
    });
  if (!references.length)
    nextActions.push({ code: "add_sourced_reference", title: labels.source });
  return {
    mode: "record_based",
    provider: "deterministic_templates",
    projectId,
    project: p,
    missingFields,
    nextTasks,
    nextActions,
    followUpQuestions: [
      ...missingFields.map((field) => ({ field, prompt: labels.details })),
      { field: "observation_evidence", prompt: labels.photo },
    ],
    readiness,
    assessment,
    recentRecords: records,
    plans,
    draftPlans: plans.filter((p) => p.status === "draft"),
    templates,
    references,
    comparisons,
    openIncidents: incidents,
    relatedCycles: (
      await ctx.db.query(
        "SELECT id,name,status,as_of_date,planting_date,current_count,count_basis FROM projects WHERE farm_id=$1 AND id<>$2 AND enterprise_type=$3 AND crop IS NOT DISTINCT FROM $4 ORDER BY created_at DESC LIMIT 10",
        [farmId, projectId, p.enterprise_type, p.crop],
      )
    ).rows,
    ...(financial
      ? {
          finance: await reportSummary(ctx.db, farmId, {
            projectId,
            period: "season",
          }),
        }
      : {}),
    ruleVersion: "record-review-2",
    recommendationsAreCompletedWork: false,
    historyComplete: false,
  };
}
