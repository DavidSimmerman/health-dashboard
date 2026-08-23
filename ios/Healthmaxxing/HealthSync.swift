import Foundation
import HealthKit
import WidgetKit

// HealthKit → dashboard sync.
//
// Four streams:
//  - `days` (→ /api/healthkit): daily activity aggregates (active/basal kcal,
//    steps, exercise minutes) for the trailing window, recomputed each sync.
//    The server upserts by date, so re-pushing today as it grows is the
//    mechanism.
//  - `bodyComp` (→ /api/healthkit): one entry per weigh-in. Anchored query on
//    body mass gives only new samples; body fat % / lean mass written by the
//    scale app at the same moment are correlated by a ±2 min timestamp window.
//  - `workouts` (→ /api/integrations/workouts): anchored query on HKWorkout,
//    with avg/max heart rate pulled from the workout window.
//  - `metrics` (→ /api/integrations/metrics): daily vitals — water, heart
//    rate (resting/min/avg/max), HRV, SpO2, respiratory rate, VO2max, BMI —
//    recomputed per day over the trailing window like `days`.
//
// Background: observer queries + enableBackgroundDelivery wake the app when
// new samples land (Watch sync, Fit Days weigh-in), each triggering a sync.
final class HealthSync {
    static let shared = HealthSync()

    private let store = HKHealthStore()
    private let calendar = Calendar.current

    private let activeEnergy = HKQuantityType(.activeEnergyBurned)
    private let basalEnergy = HKQuantityType(.basalEnergyBurned)
    private let steps = HKQuantityType(.stepCount)
    private let exerciseTime = HKQuantityType(.appleExerciseTime)
    private let bodyMass = HKQuantityType(.bodyMass)
    private let bodyFat = HKQuantityType(.bodyFatPercentage)
    private let leanMass = HKQuantityType(.leanBodyMass)
    private let water = HKQuantityType(.dietaryWater)
    private let heartRate = HKQuantityType(.heartRate)
    private let restingHeartRate = HKQuantityType(.restingHeartRate)
    private let hrv = HKQuantityType(.heartRateVariabilitySDNN)
    private let spo2 = HKQuantityType(.oxygenSaturation)
    private let respiratoryRate = HKQuantityType(.respiratoryRate)
    private let vo2Max = HKQuantityType(.vo2Max)
    private let bmi = HKQuantityType(.bodyMassIndex)

    private let bpm = HKUnit.count().unitDivided(by: .minute())

    private var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            activeEnergy, basalEnergy, steps, exerciseTime, bodyMass, bodyFat, leanMass,
            water, heartRate, restingHeartRate, hrv, spo2, respiratoryRate, vo2Max, bmi,
            HKObjectType.workoutType(),
        ]
        // The extended daily metrics (vitals, mobility, respiratory, environment,
        // category events) are spec-driven — auth reads straight off the specs so
        // there's one source of truth for "what we collect".
        for s in quantitySpecs() { types.insert(s.type) }
        for s in categorySpecs() { types.insert(s.type) }
        return types
    }

    /// How many trailing days of activity to (re)push each sync. Generous so a
    /// few days of the phone being off never leaves holes.
    private let dayWindow = 14

    private(set) var lastSyncDescription: String? {
        get { UserDefaults.standard.string(forKey: "lastSync") }
        set { UserDefaults.standard.set(newValue, forKey: "lastSync") }
    }

    // MARK: - Authorization & background delivery

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try await store.requestAuthorization(toShare: [], read: readTypes)
        startObservers()
    }

    // NOTE: nothing requests authorization automatically any more — only the settings
    // sheet's "Grant Health access" button calls requestAuthorization(). Asking on app
    // activation presented a blank permission sheet that flew up and dismissed itself
    // before it could be answered, which also meant no read type ever became
    // *determined*, so statusForAuthorizationRequest kept saying .shouldRequest and the
    // next launch tried again. Gating on that status, then on a once-per-process flag,
    // both failed to stop it. Requesting from a real user tap sidesteps the whole thing.

    /// Observer queries re-fire whenever HealthKit gets new samples of the
    /// type; background delivery lets that happen while the app is suspended.
    func startObservers() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let observed: [HKSampleType] = [bodyMass, activeEnergy, water, HKObjectType.workoutType()]
        for type in observed {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, _ in
                Task {
                    await self?.syncNow()
                    completion()
                }
            }
            store.execute(query)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    // MARK: - Sync

    func syncNow() async {
        guard SyncConfig.isConfigured else {
            lastSyncDescription = "Not configured — set the server URL and API token above"
            return
        }
        guard HKHealthStore.isHealthDataAvailable() else {
            lastSyncDescription = "Health data isn't available on this device"
            return
        }
        do {
            let days = try await collectDays()
            let comp = try await collectBodyComp()
            if !days.isEmpty || !comp.isEmpty {
                // First-ever sync can return years of weigh-ins; the server caps a
                // batch at 1000 rows, so chunk. Days ride along with the first chunk.
                let chunks = comp.isEmpty ? [[]] : stride(from: 0, to: comp.count, by: 500).map {
                    Array(comp[$0..<min($0 + 500, comp.count)])
                }
                for (i, chunk) in chunks.enumerated() {
                    try await post(
                        path: "/api/healthkit",
                        body: ["days": i == 0 ? days : [], "bodyComp": chunk])
                }
                commitBodyCompAnchor() // only after a successful POST, so failures retry
            }

            let workouts = try await collectWorkouts()
            if !workouts.isEmpty {
                try await post(path: "/api/integrations/workouts", body: ["workouts": workouts])
                commitWorkoutAnchor()
            }

            let metrics = try await collectMetrics()
            if !metrics.isEmpty {
                try await post(path: "/api/integrations/metrics", body: ["metrics": metrics])
            }

            // A sync usually means new active-energy burn, which moves the
            // deficit; refresh the widget if it has drifted enough to matter.
            await reloadWidgetIfDeficitMoved()

            let f = DateFormatter()
            f.dateStyle = .short
            f.timeStyle = .short
            lastSyncDescription =
                "Last sync \(f.string(from: Date())) — \(days.count) days, \(comp.count) weigh-ins, "
                + "\(workouts.count) workouts, \(metrics.count) metrics"
        } catch {
            lastSyncDescription = "Sync failed: \(error.localizedDescription)"
        }
    }

    /// Reload the home-screen widget when today's deficit has moved ≥10 kcal
    /// since the widget last rendered (it stores `widgetDeficit` each refresh).
    /// "Since the last update" — not a momentary jump — because the baseline only
    /// changes when the widget actually redraws. Same /api/today the widget reads,
    /// so the deficit numbers agree.
    private func reloadWidgetIfDeficitMoved() async {
        struct Today: Decodable { let deficit: Int? }
        guard let token = SyncConfig.apiToken else { return }
        var req = URLRequest(url: SyncConfig.serverURL.appending(path: "/api/today"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 15
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
            let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let deficit = (try? JSONDecoder().decode(Today.self, from: data))?.deficit
        else { return }

        let store = SyncConfig.store
        let hasBaseline = store.object(forKey: "widgetDeficit") != nil
        guard !hasBaseline || abs(deficit - store.integer(forKey: "widgetDeficit")) >= 10 else {
            return
        }
        // Optimistic baseline so back-to-back syncs don't re-reload before the
        // widget redraws and writes its own value.
        store.set(deficit, forKey: "widgetDeficit")
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: - Daily aggregates

    private func collectDays() async throws -> [[String: Any]] {
        let end = Date()
        let start = calendar.startOfDay(
            for: calendar.date(byAdding: .day, value: -(dayWindow - 1), to: end)!)

        async let active = sumsByDay(activeEnergy, unit: .kilocalorie(), from: start, to: end)
        async let basal = sumsByDay(basalEnergy, unit: .kilocalorie(), from: start, to: end)
        async let stepCounts = sumsByDay(steps, unit: .count(), from: start, to: end)
        async let exercise = sumsByDay(exerciseTime, unit: .minute(), from: start, to: end)
        let (a, b, s, e) = try await (active, basal, stepCounts, exercise)

        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        var days: [[String: Any]] = []
        var cursor = start
        while cursor <= end {
            let key = f.string(from: cursor)
            var day: [String: Any] = ["date": key]
            if let v = a[key] { day["activeKcal"] = v }
            if let v = b[key] { day["basalKcal"] = v }
            if let v = s[key] { day["steps"] = Int(v.rounded()) }
            if let v = e[key] { day["exerciseMin"] = Int(v.rounded()) }
            if day.count > 1 { days.append(day) } // skip days with no data at all
            cursor = calendar.date(byAdding: .day, value: 1, to: cursor)!
        }
        return days
    }

    private func sumsByDay(
        _ type: HKQuantityType, unit: HKUnit, from start: Date, to end: Date
    ) async throws -> [String: Double] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: calendar.startOfDay(for: start),
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error { return cont.resume(throwing: error) }
                var out: [String: Double] = [:]
                collection?.enumerateStatistics(from: start, to: end) { stat, _ in
                    if let sum = stat.sumQuantity() {
                        out[f.string(from: stat.startDate)] = sum.doubleValue(for: unit)
                    }
                }
                cont.resume(returning: out)
            }
            store.execute(query)
        }
    }

    // MARK: - Body composition

    /// Anchor staged here between query and successful POST.
    private var pendingAnchor: HKQueryAnchor?

    private func collectBodyComp() async throws -> [[String: Any]] {
        let anchor: HKQueryAnchor? = UserDefaults.standard.data(forKey: "bodyMassAnchor")
            .flatMap {
                try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
            }

        let (samples, newAnchor) = try await anchoredSamples(bodyMass, anchor: anchor)
        pendingAnchor = newAnchor

        var entries: [[String: Any]] = []
        let iso = ISO8601DateFormatter()
        for sample in samples {
            let at = sample.startDate
            var entry: [String: Any] = [
                "hkUuid": sample.uuid.uuidString,
                "measuredAt": iso.string(from: at),
                "weightKg": sample.quantity.doubleValue(for: .gramUnit(with: .kilo)),
                "source": sample.sourceRevision.source.bundleIdentifier,
            ]
            // The scale app writes composition samples at (nearly) the same
            // instant as the weight — pick them up from a ±2 min window.
            if let fat = try await nearestQuantity(bodyFat, around: at) {
                entry["bodyFatPct"] = fat.doubleValue(for: .percent()) * 100
            }
            if let lean = try await nearestQuantity(leanMass, around: at) {
                entry["leanMassKg"] = lean.doubleValue(for: .gramUnit(with: .kilo))
            }
            entries.append(entry)
        }
        return entries
    }

    private func commitBodyCompAnchor() {
        guard let anchor = pendingAnchor,
            let data = try? NSKeyedArchiver.archivedData(
                withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: "bodyMassAnchor")
        pendingAnchor = nil
    }

    private func anchoredSamples(
        _ type: HKQuantityType, anchor: HKQueryAnchor?
    ) async throws -> ([HKQuantitySample], HKQueryAnchor?) {
        try await withCheckedThrowingContinuation { cont in
            let query = HKAnchoredObjectQuery(
                type: type, predicate: nil, anchor: anchor, limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error { return cont.resume(throwing: error) }
                cont.resume(returning: ((samples as? [HKQuantitySample]) ?? [], newAnchor))
            }
            store.execute(query)
        }
    }

    private func nearestQuantity(
        _ type: HKQuantityType, around date: Date
    ) async throws -> HKQuantity? {
        let predicate = HKQuery.predicateForSamples(
            withStart: date.addingTimeInterval(-120), end: date.addingTimeInterval(120))
        return try await withCheckedThrowingContinuation { cont in
            let query = HKSampleQuery(
                sampleType: type, predicate: predicate, limit: 1,
                sortDescriptors: [
                    NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                ]
            ) { _, samples, error in
                if let error { return cont.resume(throwing: error) }
                cont.resume(returning: (samples?.first as? HKQuantitySample)?.quantity)
            }
            store.execute(query)
        }
    }

    // MARK: - Workouts

    /// Workout anchor staged here between query and successful POST.
    private var pendingWorkoutAnchor: HKQueryAnchor?

    private func collectWorkouts() async throws -> [[String: Any]] {
        // One-time backfill: distanceKm (v2) and then appleActiveKcal (v3) were added after
        // workouts had already synced. Clearing the anchor once re-POSTs every workout WITH
        // the new field (the server upsert is idempotent, so re-sending is harmless).
        // Versioned flag → runs once per field added.
        if !UserDefaults.standard.bool(forKey: "workoutDistanceBackfilled_v3") {
            UserDefaults.standard.removeObject(forKey: "workoutAnchor")
            UserDefaults.standard.set(true, forKey: "workoutDistanceBackfilled_v3")
        }
        let anchor: HKQueryAnchor? = UserDefaults.standard.data(forKey: "workoutAnchor")
            .flatMap {
                try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
            }

        let (samples, newAnchor): ([HKSample], HKQueryAnchor?) =
            try await withCheckedThrowingContinuation { cont in
                let query = HKAnchoredObjectQuery(
                    type: HKObjectType.workoutType(), predicate: nil, anchor: anchor,
                    limit: HKObjectQueryNoLimit
                ) { _, samples, _, newAnchor, error in
                    if let error { return cont.resume(throwing: error) }
                    cont.resume(returning: (samples ?? [], newAnchor))
                }
                store.execute(query)
            }
        pendingWorkoutAnchor = newAnchor

        var entries: [[String: Any]] = []
        let iso = ISO8601DateFormatter()
        for case let workout as HKWorkout in samples {
            var entry: [String: Any] = [
                "hkUuid": workout.uuid.uuidString,
                "name": Self.activityName(workout.workoutActivityType),
                "start": iso.string(from: workout.startDate),
                "end": iso.string(from: workout.endDate),
                // Source bundle id: dedicated trackers (walking pad) are trusted at
                // full value server-side; Apple's own estimates get the haircut.
                "source": workout.sourceRevision.source.bundleIdentifier,
            ]
            if let energy = workout.statistics(for: activeEnergy)?.sumQuantity()
                ?? workout.totalEnergyBurned
            {
                entry["kcal"] = energy.doubleValue(for: .kilocalorie())
            }
            // Walking/running distance drives the running-mileage goal. Sum the
            // distance SAMPLES in the workout window — workout.statistics(for:) is
            // nil/partial for imported (third-party) workouts. Omit when there's no
            // distance; never send 0.
            if let km = try await walkRunDistanceKm(from: workout.startDate, to: workout.endDate),
                km > 0
            {
                entry["distanceKm"] = km
            }
            // How much active energy Apple ALREADY counted for this window, straight from the
            // activeEnergyBurned samples. Not the workout's energy — it's the slice of the day's
            // active total this hour occupies, so the server can swap in its own figure for the
            // window instead of subtracting it from the daily number (see correctActive).
            // Sent even when 0 (Watch off ⇒ Apple counted nothing): 0 and "unknown" mean
            // different things here, and only nil means "this app version didn't report it".
            if let counted = try await activeEnergyKcal(from: workout.startDate, to: workout.endDate)
            {
                entry["appleActiveKcal"] = counted
            }
            if let stats = try await heartRateStats(from: workout.startDate, to: workout.endDate) {
                if let avg = stats.averageQuantity() {
                    entry["avgHr"] = avg.doubleValue(for: bpm)
                }
                if let max = stats.maximumQuantity() {
                    entry["maxHr"] = max.doubleValue(for: bpm)
                }
            }
            entries.append(entry)
        }
        return entries
    }

    private func commitWorkoutAnchor() {
        guard let anchor = pendingWorkoutAnchor,
            let data = try? NSKeyedArchiver.archivedData(
                withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: "workoutAnchor")
        pendingWorkoutAnchor = nil
    }

    private func heartRateStats(from start: Date, to end: Date) async throws -> HKStatistics? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsQuery(
                quantityType: heartRate, quantitySamplePredicate: predicate,
                options: [.discreteAverage, .discreteMax]
            ) { _, stats, error in
                // HKStatisticsQuery throws errorNoData when the workout window has no
                // HR samples (phone-only strength, Watch-less walk). Benign — skip HR
                // for that workout rather than sinking the whole sync. Surface the rest.
                if let error {
                    if (error as? HKError)?.code == .errorNoData {
                        return cont.resume(returning: nil)
                    }
                    return cont.resume(throwing: error)
                }
                cont.resume(returning: stats)
            }
            store.execute(query)
        }
    }

    /// Summed walking/running distance (km) over a workout window, straight from
    /// the distance samples — authoritative even when the workout carries no
    /// statistics. nil when there are no distance samples (errorNoData).
    private func walkRunDistanceKm(from start: Date, to end: Date) async throws -> Double? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsQuery(
                quantityType: HKQuantityType(.distanceWalkingRunning),
                quantitySamplePredicate: predicate, options: .cumulativeSum
            ) { _, stats, error in
                if let error {
                    if (error as? HKError)?.code == .errorNoData { return cont.resume(returning: nil) }
                    return cont.resume(throwing: error)
                }
                cont.resume(returning: stats?.sumQuantity()?.doubleValue(for: .meterUnit(with: .kilo)))
            }
            store.execute(query)
        }
    }

    /// Apple's own activeEnergyBurned summed over a workout window — how much of the day's
    /// active total that window already accounts for. Same sample-summing trick as
    /// walkRunDistanceKm: authoritative even for imported third-party workouts, which carry
    /// no statistics of their own. Returns 0 (not nil) when HealthKit reports no samples, so
    /// the server can tell "Watch was off, Apple counted nothing" apart from "not reported".
    private func activeEnergyKcal(from start: Date, to end: Date) async throws -> Double? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsQuery(
                quantityType: activeEnergy,
                quantitySamplePredicate: predicate, options: .cumulativeSum
            ) { _, stats, error in
                if let error {
                    if (error as? HKError)?.code == .errorNoData { return cont.resume(returning: 0) }
                    return cont.resume(throwing: error)
                }
                cont.resume(returning: stats?.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? 0)
            }
            store.execute(query)
        }
    }

    /// Common activity types, mapped to readable names. Extend as needed.
    private static func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .traditionalStrengthTraining: return "Strength Training"
        case .functionalStrengthTraining: return "Functional Strength"
        case .running: return "Run"
        case .walking: return "Walk"
        case .hiking: return "Hike"
        case .cycling: return "Cycle"
        case .swimming: return "Swim"
        case .rowing: return "Rowing"
        case .elliptical: return "Elliptical"
        case .stairClimbing: return "Stair Climbing"
        case .highIntensityIntervalTraining: return "HIIT"
        case .yoga: return "Yoga"
        case .pilates: return "Pilates"
        case .coreTraining: return "Core Training"
        case .flexibility: return "Stretching"
        case .basketball: return "Basketball"
        case .soccer: return "Soccer"
        case .tennis: return "Tennis"
        case .golf: return "Golf"
        case .mixedCardio: return "Mixed Cardio"
        case .crossTraining: return "Cross Training"
        case .martialArts: return "Martial Arts"
        case .climbing: return "Climbing"
        default: return "Workout"
        }
    }

    // MARK: - Daily vitals

    /// Daily metric definitions: HealthKit type → (metric key, unit, how to
    /// aggregate a day). Adding a row here is all it takes to ship a new
    /// metric — the server table is (date, metric, value).
    private func collectMetrics() async throws -> [[String: Any]] {
        let end = Date()
        let start = calendar.startOfDay(
            for: calendar.date(byAdding: .day, value: -(dayWindow - 1), to: end)!)

        var metrics: [[String: Any]] = []
        func add(_ byDay: [String: Double], as name: String, scale: Double = 1) {
            for (date, value) in byDay {
                metrics.append(["date": date, "metric": name, "value": value * scale])
            }
        }

        async let waterByDay = sumsByDay(water, unit: .liter(), from: start, to: end)
        async let restingByDay = discreteByDay(restingHeartRate, unit: bpm, .discreteAverage, from: start, to: end)
        async let hrAvgByDay = discreteByDay(heartRate, unit: bpm, .discreteAverage, from: start, to: end)
        async let hrMinByDay = discreteByDay(heartRate, unit: bpm, .discreteMin, from: start, to: end)
        async let hrMaxByDay = discreteByDay(heartRate, unit: bpm, .discreteMax, from: start, to: end)
        async let hrvByDay = discreteByDay(hrv, unit: .secondUnit(with: .milli), .discreteAverage, from: start, to: end)
        async let spo2ByDay = discreteByDay(spo2, unit: .percent(), .discreteAverage, from: start, to: end)
        async let respByDay = discreteByDay(respiratoryRate, unit: bpm, .discreteAverage, from: start, to: end)
        async let vo2ByDay = discreteByDay(vo2Max, unit: HKUnit(from: "ml/kg*min"), .discreteAverage, from: start, to: end)
        async let bmiByDay = discreteByDay(bmi, unit: .count(), .discreteAverage, from: start, to: end)

        add(try await waterByDay, as: "water_l")
        add(try await restingByDay, as: "resting_hr")
        add(try await hrAvgByDay, as: "hr_avg")
        add(try await hrMinByDay, as: "hr_min")
        add(try await hrMaxByDay, as: "hr_max")
        add(try await hrvByDay, as: "hrv_ms")
        add(try await spo2ByDay, as: "spo2_pct", scale: 100)
        add(try await respByDay, as: "resp_rate")
        add(try await vo2ByDay, as: "vo2max")
        add(try await bmiByDay, as: "bmi")

        // Extended panel — everything else the user wants tracked. Spec-driven, so
        // a new metric is one line in quantitySpecs()/categorySpecs().
        metrics += try await collectExtendedQuantityMetrics(from: start, to: end)
        metrics += try await collectCategoryMetrics(from: start, to: end)
        return metrics
    }

    // MARK: - Extended daily metrics (bulk)

    private enum Agg { case sum, avg, max }
    private struct QSpec {
        let type: HKQuantityType
        let unit: HKUnit
        let agg: Agg
        let name: String
        var scale: Double = 1
    }

    /// Daily quantity metrics beyond the core vitals. `name` must match the server
    /// catalog (mcp get_health_metrics) and the ingest regex `^[a-z][a-z0-9_]{0,39}$`.
    /// Percent types are scaled ×100 to store 0–100 (like spo2_pct).
    private func quantitySpecs() -> [QSpec] {
        let mps = HKUnit.meter().unitDivided(by: .second())
        let km = HKUnit.meterUnit(with: .kilo)
        let cm = HKUnit.meterUnit(with: .centi)
        let lpm = HKUnit.liter().unitDivided(by: .minute())
        let db = HKUnit.decibelAWeightedSoundPressureLevel()
        let effort = HKUnit.kilocalorie().unitDivided(
            by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .hour())) // kcal/(kg·hr)

        var specs: [QSpec] = [
            // ── Activity ──
            QSpec(type: HKQuantityType(.flightsClimbed), unit: .count(), agg: .sum, name: "flights_climbed"),
            QSpec(type: HKQuantityType(.appleStandTime), unit: .minute(), agg: .sum, name: "stand_min"),
            QSpec(type: HKQuantityType(.appleMoveTime), unit: .minute(), agg: .sum, name: "move_min"),
            QSpec(type: HKQuantityType(.timeInDaylight), unit: .minute(), agg: .sum, name: "daylight_min"),
            QSpec(type: HKQuantityType(.distanceWalkingRunning), unit: km, agg: .sum, name: "dist_walk_run_km"),
            QSpec(type: HKQuantityType(.distanceCycling), unit: km, agg: .sum, name: "dist_cycle_km"),
            QSpec(type: HKQuantityType(.distanceSwimming), unit: km, agg: .sum, name: "dist_swim_km"),
            QSpec(type: HKQuantityType(.distanceWheelchair), unit: km, agg: .sum, name: "dist_wheelchair_km"),
            QSpec(type: HKQuantityType(.distanceDownhillSnowSports), unit: km, agg: .sum, name: "dist_snow_km"),
            QSpec(type: HKQuantityType(.pushCount), unit: .count(), agg: .sum, name: "push_count"),
            QSpec(type: HKQuantityType(.swimmingStrokeCount), unit: .count(), agg: .sum, name: "swim_strokes"),
            // ── Vitals ──
            QSpec(type: HKQuantityType(.walkingHeartRateAverage), unit: bpm, agg: .avg, name: "walking_hr_avg"),
            QSpec(type: HKQuantityType(.heartRateRecoveryOneMinute), unit: bpm, agg: .avg, name: "hr_recovery"),
            QSpec(type: HKQuantityType(.bloodPressureSystolic), unit: .millimeterOfMercury(), agg: .avg, name: "bp_systolic"),
            QSpec(type: HKQuantityType(.bloodPressureDiastolic), unit: .millimeterOfMercury(), agg: .avg, name: "bp_diastolic"),
            QSpec(type: HKQuantityType(.bodyTemperature), unit: .degreeCelsius(), agg: .avg, name: "body_temp_c"),
            QSpec(type: HKQuantityType(.basalBodyTemperature), unit: .degreeCelsius(), agg: .avg, name: "basal_body_temp_c"),
            QSpec(type: HKQuantityType(.appleSleepingWristTemperature), unit: .degreeCelsius(), agg: .avg, name: "wrist_temp_c"),
            QSpec(type: HKQuantityType(.bloodGlucose), unit: HKUnit(from: "mg/dL"), agg: .avg, name: "blood_glucose_mgdl"),
            QSpec(type: HKQuantityType(.insulinDelivery), unit: .internationalUnit(), agg: .sum, name: "insulin_iu"),
            QSpec(type: HKQuantityType(.bloodAlcoholContent), unit: .percent(), agg: .avg, name: "blood_alcohol_pct", scale: 100),
            QSpec(type: HKQuantityType(.atrialFibrillationBurden), unit: .percent(), agg: .avg, name: "afib_burden_pct", scale: 100),
            QSpec(type: HKQuantityType(.peripheralPerfusionIndex), unit: .percent(), agg: .avg, name: "perfusion_index_pct", scale: 100),
            QSpec(type: HKQuantityType(.electrodermalActivity), unit: .siemenUnit(with: .micro), agg: .avg, name: "electrodermal_us"),
            QSpec(type: HKQuantityType(.height), unit: cm, agg: .avg, name: "height_cm"),
            // ── Mobility / gait ──
            QSpec(type: HKQuantityType(.walkingSpeed), unit: mps, agg: .avg, name: "walking_speed_mps"),
            QSpec(type: HKQuantityType(.walkingStepLength), unit: .meter(), agg: .avg, name: "step_length_m"),
            QSpec(type: HKQuantityType(.walkingAsymmetryPercentage), unit: .percent(), agg: .avg, name: "walking_asymmetry_pct", scale: 100),
            QSpec(type: HKQuantityType(.walkingDoubleSupportPercentage), unit: .percent(), agg: .avg, name: "double_support_pct", scale: 100),
            QSpec(type: HKQuantityType(.appleWalkingSteadiness), unit: .percent(), agg: .avg, name: "walking_steadiness_pct", scale: 100),
            QSpec(type: HKQuantityType(.sixMinuteWalkTestDistance), unit: .meter(), agg: .avg, name: "six_min_walk_m"),
            QSpec(type: HKQuantityType(.stairAscentSpeed), unit: mps, agg: .avg, name: "stair_ascent_mps"),
            QSpec(type: HKQuantityType(.stairDescentSpeed), unit: mps, agg: .avg, name: "stair_descent_mps"),
            QSpec(type: HKQuantityType(.numberOfTimesFallen), unit: .count(), agg: .sum, name: "falls"),
            QSpec(type: HKQuantityType(.runningSpeed), unit: mps, agg: .avg, name: "running_speed_mps"),
            QSpec(type: HKQuantityType(.runningPower), unit: .watt(), agg: .avg, name: "running_power_w"),
            QSpec(type: HKQuantityType(.runningStrideLength), unit: .meter(), agg: .avg, name: "running_stride_m"),
            QSpec(type: HKQuantityType(.runningVerticalOscillation), unit: cm, agg: .avg, name: "running_vert_osc_cm"),
            QSpec(type: HKQuantityType(.runningGroundContactTime), unit: .secondUnit(with: .milli), agg: .avg, name: "running_gct_ms"),
            // ── Respiratory / hearing / environment ──
            QSpec(type: HKQuantityType(.forcedVitalCapacity), unit: .liter(), agg: .avg, name: "fvc_l"),
            QSpec(type: HKQuantityType(.forcedExpiratoryVolume1), unit: .liter(), agg: .avg, name: "fev1_l"),
            QSpec(type: HKQuantityType(.peakExpiratoryFlowRate), unit: lpm, agg: .avg, name: "peak_flow_lpm"),
            QSpec(type: HKQuantityType(.inhalerUsage), unit: .count(), agg: .sum, name: "inhaler_uses"),
            QSpec(type: HKQuantityType(.environmentalAudioExposure), unit: db, agg: .avg, name: "env_audio_db"),
            QSpec(type: HKQuantityType(.headphoneAudioExposure), unit: db, agg: .avg, name: "headphone_audio_db"),
            QSpec(type: HKQuantityType(.uvExposure), unit: .count(), agg: .max, name: "uv_index"),
            QSpec(type: HKQuantityType(.underwaterDepth), unit: .meter(), agg: .max, name: "underwater_depth_m"),
            QSpec(type: HKQuantityType(.waterTemperature), unit: .degreeCelsius(), agg: .avg, name: "water_temp_c"),
            QSpec(type: HKQuantityType(.physicalEffort), unit: effort, agg: .avg, name: "physical_effort"),
        ]

        // iOS 18-only types. Requires the iOS 18 SDK (Xcode 16+) to compile; if you
        // build on older Xcode, delete this block — the rest is iOS 17-safe.
        if #available(iOS 18.0, *) {
            specs += [
                QSpec(type: HKQuantityType(.distanceCrossCountrySkiing), unit: km, agg: .sum, name: "dist_xc_ski_km"),
                QSpec(type: HKQuantityType(.distancePaddleSports), unit: km, agg: .sum, name: "dist_paddle_km"),
                QSpec(type: HKQuantityType(.distanceRowing), unit: km, agg: .sum, name: "dist_row_km"),
                // ponytail: sound reduction is in dB; verify the unit on first real sample.
                QSpec(type: HKQuantityType(.environmentalSoundReduction), unit: db, agg: .avg, name: "sound_reduction_db"),
            ]
        }
        return specs
    }

    /// Run each quantity spec over the window and flatten to (date, metric, value)
    /// rows. ponytail: sequential — ~50 quick stats queries per sync is fine for a
    /// background refresh; parallelize with a task group if sync latency matters.
    private func collectExtendedQuantityMetrics(from start: Date, to end: Date) async throws
        -> [[String: Any]]
    {
        var rows: [[String: Any]] = []
        for spec in quantitySpecs() {
            do {
                let byDay: [String: Double]
                switch spec.agg {
                case .sum: byDay = try await sumsByDay(spec.type, unit: spec.unit, from: start, to: end)
                case .avg: byDay = try await discreteByDay(spec.type, unit: spec.unit, .discreteAverage, from: start, to: end)
                case .max: byDay = try await discreteByDay(spec.type, unit: spec.unit, .discreteMax, from: start, to: end)
                }
                for (date, value) in byDay {
                    rows.append(["date": date, "metric": spec.name, "value": value * spec.scale])
                }
            } catch {
                // Isolate per metric: a type whose aggregation style rejects this
                // option (e.g. audio exposure) or any single-query error must not
                // sink the whole sync. Skip it; the rest still upload.
                continue
            }
        }
        return rows
    }

    // ── Category events ──
    private enum CatAgg { case count, stoodHours, durationMin }
    private struct CSpec {
        let type: HKCategoryType
        let name: String
        let agg: CatAgg
    }

    /// Category-type events, aggregated to one number per day: a count of samples,
    /// the count of "stood" stand-hours, or summed duration in minutes.
    private func categorySpecs() -> [CSpec] {
        var specs: [CSpec] = [
            CSpec(type: HKCategoryType(.mindfulSession), name: "mindful_min", agg: .durationMin),
            CSpec(type: HKCategoryType(.appleStandHour), name: "stand_hours", agg: .stoodHours),
            CSpec(type: HKCategoryType(.lowHeartRateEvent), name: "low_hr_events", agg: .count),
            CSpec(type: HKCategoryType(.highHeartRateEvent), name: "high_hr_events", agg: .count),
            CSpec(type: HKCategoryType(.irregularHeartRhythmEvent), name: "irregular_rhythm_events", agg: .count),
            CSpec(type: HKCategoryType(.lowCardioFitnessEvent), name: "low_cardio_events", agg: .count),
            CSpec(type: HKCategoryType(.environmentalAudioExposureEvent), name: "env_audio_events", agg: .count),
            CSpec(type: HKCategoryType(.headphoneAudioExposureEvent), name: "headphone_audio_events", agg: .count),
            CSpec(type: HKCategoryType(.appleWalkingSteadinessEvent), name: "walking_steadiness_events", agg: .count),
            CSpec(type: HKCategoryType(.handwashingEvent), name: "handwashing_events", agg: .count),
            CSpec(type: HKCategoryType(.toothbrushingEvent), name: "toothbrushing_events", agg: .count),
        ]
        // No sleep_apnea_events: there's no such HKCategoryTypeIdentifier (the iOS 18
        // apnea signal is a quantity/notification), and sleep comes from Google Health.
        return specs
    }

    private func collectCategoryMetrics(from start: Date, to end: Date) async throws -> [[String: Any]] {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        var rows: [[String: Any]] = []
        for spec in categorySpecs() {
            let samples: [HKCategorySample]
            do {
                samples = try await categorySamples(spec.type, from: start, to: end)
            } catch {
                continue // isolate per metric — one failed query must not sink the sync
            }
            var byDay: [String: Double] = [:]
            for s in samples {
                let key = f.string(from: s.startDate)
                switch spec.agg {
                case .count:
                    byDay[key, default: 0] += 1
                case .stoodHours:
                    if s.value == HKCategoryValueAppleStandHour.stood.rawValue { byDay[key, default: 0] += 1 }
                case .durationMin:
                    byDay[key, default: 0] += s.endDate.timeIntervalSince(s.startDate) / 60
                }
            }
            for (date, v) in byDay { rows.append(["date": date, "metric": spec.name, "value": v]) }
        }
        return rows
    }

    private func categorySamples(
        _ type: HKCategoryType, from start: Date, to end: Date
    ) async throws -> [HKCategorySample] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return try await withCheckedThrowingContinuation { cont in
            let query = HKSampleQuery(
                sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error { return cont.resume(throwing: error) }
                cont.resume(returning: (samples as? [HKCategorySample]) ?? [])
            }
            store.execute(query)
        }
    }

    /// Like sumsByDay but for discrete types (heart rate, HRV, SpO2…): one
    /// avg/min/max value per day.
    private func discreteByDay(
        _ type: HKQuantityType, unit: HKUnit, _ option: HKStatisticsOptions,
        from start: Date, to end: Date
    ) async throws -> [String: Double] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: option,
                anchorDate: calendar.startOfDay(for: start),
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error { return cont.resume(throwing: error) }
                var out: [String: Double] = [:]
                collection?.enumerateStatistics(from: start, to: end) { stat, _ in
                    let quantity: HKQuantity? =
                        switch option {
                        case .discreteMin: stat.minimumQuantity()
                        case .discreteMax: stat.maximumQuantity()
                        default: stat.averageQuantity()
                        }
                    if let quantity {
                        out[f.string(from: stat.startDate)] = quantity.doubleValue(for: unit)
                    }
                }
                cont.resume(returning: out)
            }
            store.execute(query)
        }
    }

    // MARK: - Upload

    private func post(path: String, body: [String: Any]) async throws {
        guard let token = SyncConfig.apiToken else { return }
        var request = URLRequest(url: SyncConfig.serverURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else {
            let detail = String(data: data, encoding: .utf8) ?? ""
            throw NSError(
                domain: "HealthSync", code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey: "Server rejected sync: \(detail.prefix(200))"
                ])
        }
    }
}
