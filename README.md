# SK-to-PCO-Conversion
Convert ServantKeeper csv to PCO compatible CSV


Program usage:
    python 'SK to PCO conversion.py' <csv from SK.csv> <csv output to PCO.csv>

    Converts a csv export from ServantKeeper to Planning Center
    Online People import.
    Edit replaceDict to add or remove conversion fields.
    This converts Individual ID and Family ID to hex string equivalents;
    decimal values are too large for PCO People import.
