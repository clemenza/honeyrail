from textkit.stats import median


def test_median_odd_unsorted():
    assert median([9, 1, 5]) == 5


def test_median_even_unsorted():
    assert median([7, 1, 3, 5]) == 4.0


def test_median_single():
    assert median([2]) == 2
