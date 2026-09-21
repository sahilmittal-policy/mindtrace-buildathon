from pathlib import Path
import sys

import pandas as pd


def analyze_sessions(input_path: str) -> pd.DataFrame:
    data = pd.read_csv(input_path)

    if "date" not in data.columns:
        raise ValueError("The CSV must contain a date column.")

    data["date"] = pd.to_datetime(data["date"], errors="coerce")
    data = data.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

    numeric_columns = [
        "sleep_hours",
        "sleep_quality",
        "mood",
        "stress",
        "energy",
        "composite",
        "speed",
        "focus",
        "memory",
        "words",
        "response_time",
    ]

    for column in numeric_columns:
        if column in data.columns:
            data[column] = pd.to_numeric(data[column], errors="coerce")

    if "response_time" in data.columns:
        data["response_time_7_session_average"] = (
            data["response_time"]
            .rolling(window=7, min_periods=1)
            .mean()
            .round(2)
        )

        data["response_time_baseline"] = (
            data["response_time"]
            .shift(1)
            .rolling(window=14, min_periods=1)
            .mean()
            .round(2)
        )

        data["response_time_deviation_percent"] = (
            (
                data["response_time"]
                - data["response_time_baseline"]
            )
            / data["response_time_baseline"]
            * 100
        ).round(1)

    if "composite" in data.columns:
        data["composite_7_session_average"] = (
            data["composite"]
            .rolling(window=7, min_periods=1)
            .mean()
            .round(2)
        )

        data["composite_baseline"] = (
            data["composite"]
            .shift(1)
            .rolling(window=14, min_periods=1)
            .mean()
            .round(2)
        )

        data["composite_deviation_percent"] = (
            (
                data["composite"]
                - data["composite_baseline"]
            )
            / data["composite_baseline"]
            * 100
        ).round(1)

    return data


def print_associations(data: pd.DataFrame) -> None:
    possible_outcomes = [
        "response_time",
        "composite",
        "speed",
        "focus",
        "memory",
        "words",
    ]

    possible_context = [
        "sleep_hours",
        "sleep_quality",
        "stress",
        "mood",
        "energy",
        "caffeine",
    ]

    outcomes = [
        column for column in possible_outcomes
        if column in data.columns
    ]

    context_columns = [
        column for column in possible_context
        if column in data.columns
    ]

    if not outcomes or not context_columns:
        print("\nNo matching context and performance columns were found.")
        return

    print("\nAssociations")
    print("------------")

    for outcome in outcomes:
        for context in context_columns:
            paired = data[[context, outcome]].dropna()

            if len(paired) < 5:
                continue

            value = paired[context].corr(paired[outcome])

            if pd.notna(value):
                print(
                    f"{context} vs {outcome}: "
                    f"r = {value:.2f} "
                    f"using {len(paired)} sessions"
                )


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python3 analytics.py path/to/exported-sessions.csv")
        raise SystemExit(1)

    input_path = Path(sys.argv[1])

    if not input_path.exists():
        print(f"File not found: {input_path}")
        raise SystemExit(1)

    try:
        analyzed = analyze_sessions(str(input_path))
    except ValueError as error:
        print(f"Could not analyze file: {error}")
        raise SystemExit(1)

    output_path = input_path.with_name(
        f"{input_path.stem}-analyzed.csv"
    )

    analyzed.to_csv(output_path, index=False)

    print(f"Analyzed {len(analyzed)} sessions.")
    print(f"Saved results to: {output_path}")

    print_associations(analyzed)


if __name__ == "__main__":
    main()