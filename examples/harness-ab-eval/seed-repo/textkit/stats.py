def median(values):
    """Return the median of a non-empty list of numbers."""
    ordered = list(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2
