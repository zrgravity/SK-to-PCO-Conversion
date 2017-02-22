import csv
import sys

replaceDict = {
    'Family ID': 'Household ID',
    'Last Name': 'Last Name',
    'First Name': 'First Name',
    'Middle Name': 'Middle Name',
    'Home Phone': 'Home Phone Number',
    'Wedding Date': 'Anniversary',
    'Address': 'Home Address Street Line 1',
    'Age': '',
    'Baptized': 'Baptized',
    'Baptized Date': 'Baptized Date',
    'Birth Date': 'Birthdate',
    'Cell Phone': 'Mobile Phone Number',
    'E-Mail': 'Home Email',
    'Email 2': 'Work Email',
    'Employer': '',
    'Gender': 'Gender',
    'Include in Directory': 'Include in Directory',
    'Individual ID': '',
    'Marital Status': 'Marital Status',
    'Member Status': 'Membership',
    'Occupation': '',
    'Preferred Name': '',
    'City': 'Home Address City',
    'Date Last Edited': '',
    'Phone': '',
    'State': 'Home Address State',
    'Work Phone': 'Work Phone Number',
    'Zip Code': 'Home Address Zip Code',
}

if len(sys.argv) != 3:
    print """Program usage:
    python 'SK to PCO conversion.py' <csv from SK.csv> <csv output to PCO.csv>

    Converts a csv export from ServantKeeper to Planning Center
    Online People import.
    Edit replaceDict to add or remove conversion fields.
    This converts Individual ID and Family ID to hex string equivalents;
    decimal values are too large for PCO People import.
    """
    sys.exit(1)

outputHeader = []
for key in replaceDict:
    if replaceDict[key] != '':
        outputHeader.append(replaceDict[key])
# print outputHeader


with open(sys.argv[1], 'rb') as readfile, open(sys.argv[2], 'w') as writefile:
    # csvreader = csv.reader(readfile, delimiter=',', quotechar='"')
    # csvdata = list(csvreader)

    csvreader = csv.DictReader(readfile, delimiter=',',
                               quotechar='"', quoting=csv.QUOTE_ALL)

    csvwriter = csv.DictWriter(writefile, outputHeader,
                               quotechar='"', quoting=csv.QUOTE_ALL)
    csvwriter.writeheader()

    for row in csvreader:
        rowDict = {}
        for key in replaceDict:
            if replaceDict[key] != '':
                # remote_id or family id
                if replaceDict[key] == 'remote_id' or \
                   replaceDict[key] == 'Household ID':
                    rowDict[replaceDict[key]] = format(int(row[key]), 'x')
                # dates with ' / / '
                elif row[key] == '  /  /    ':
                    rowDict[replaceDict[key]] = ''
                # else
                else:
                    rowDict[replaceDict[key]] = row[key]
        csvwriter.writerow(rowDict)
