export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "predict-control-room",
      workerReadiness: "check_authenticated_observability",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
