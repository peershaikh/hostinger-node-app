"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_HUBS = exports.GLOBAL_HUBS = exports.HUB_REGIONS = void 0;
exports.HUB_REGIONS = {
    MAHARASHTRA: ['MUMBAI', 'PUNE', 'KALYAN', 'NAGPUR', 'SAWANTWADI', 'MANMAD', 'BHUSAVAL', 'WARDHA', 'SOLAPUR', 'AKOLA', 'RATNAGIRI'],
    NORTH: ['DELHI', 'KANPUR', 'LUCKNOW', 'PRAYAGRAJ', 'AMBALA', 'JHANSI', 'MORADABAD', 'BAREILLY', 'TUNDLA', 'GORAKHPUR', 'GONDA', 'BASTI'],
    SOUTH: ['CHENNAI', 'VIJAYAWADA', 'SECUNDERABAD', 'BANGALORE', 'HYDERABAD', 'JOLARPETTAI', 'KATPADI', 'GUNTAKAL', 'RENIGUNTA', 'GUDUR', 'HUBLI', 'GADAG', 'MYSORE', 'MANGALORE'],
    WEST: ['SURAT', 'VADODARA', 'AHMEDABAD', 'RAJKOT', 'RATLAM', 'KOTA', 'JAIPUR', 'JALGAON'],
    EAST: ['HOWRAH', 'SEALDAH', 'PATNA', 'KHARAGPUR', 'KOLKATA', 'MUGHALSARAI', 'ASANSOL', 'DHANBAD', 'GAYA', 'MUZAFFARPUR', 'BHAGALPUR', 'DARBHANGA'],
    CENTRAL: ['BHOPAL', 'ITARSI', 'JABALPUR', 'NAGPUR', 'BHUSAVAL', 'WARDHA']
};
exports.GLOBAL_HUBS = ['ITARSI', 'VIJAYAWADA', 'NAGPUR', 'NEW DELHI', 'JHANSI', 'BHOPAL', 'MUGHALSARAI', 'KALYAN'];
exports.ALL_HUBS = [
    // NORTH
    { name: 'NEW DELHI', dbAliases: ['NEW DELHI', 'NDLS', 'DELHI'], region: 'NORTH' },
    { name: 'KANPUR CENTRAL', dbAliases: ['KANPUR CENTRAL', 'CNB'], region: 'NORTH' },
    { name: 'LUCKNOW', dbAliases: ['LKO', 'LUCKNOW'], region: 'NORTH' },
    { name: 'PRAYAGRAJ', dbAliases: ['PRYJ', 'ALLAHABAD'], region: 'NORTH' },
    { name: 'JHANSI', dbAliases: ['VGLJ', 'JHANSI'], region: 'NORTH' },
    { name: 'MORADABAD', dbAliases: ['MB', 'MORADABAD'], region: 'NORTH' },
    { name: 'BAREILLY', dbAliases: ['BE', 'BAREILLY'], region: 'NORTH' },
    { name: 'TUNDLA', dbAliases: ['TDL', 'TUNDLA'], region: 'NORTH' },
    { name: 'AMBALA CANTT', dbAliases: ['UMB', 'AMBALA'], region: 'NORTH' },
    { name: 'GORAKHPUR', dbAliases: ['GKP', 'GORAKHPUR'], region: 'NORTH' },
    { name: 'GONDA', dbAliases: ['GD', 'GONDA'], region: 'NORTH' },
    { name: 'BASTI', dbAliases: ['BST', 'BASTI'], region: 'NORTH' },
    // CENTRAL / MAHARASHTRA
    { name: 'BHOPAL', dbAliases: ['BHOPAL', 'BPL'], region: 'CENTRAL' },
    { name: 'ITARSI', dbAliases: ['ITARSI', 'ET'], region: 'CENTRAL' },
    { name: 'JABALPUR', dbAliases: ['JBP', 'JABALPUR'], region: 'CENTRAL' },
    { name: 'NAGPUR', dbAliases: ['NAGPUR', 'NGP'], region: 'MAHARASHTRA' },
    { name: 'BHUSAVAL', dbAliases: ['BSL', 'BHUSAVAL'], region: 'CENTRAL' },
    { name: 'MANMAD', dbAliases: ['MMR', 'MANMAD'], region: 'MAHARASHTRA' },
    { name: 'KALYAN', dbAliases: ['KALYAN', 'KYN'], region: 'MAHARASHTRA' },
    { name: 'PUNE', dbAliases: ['PUNE', 'PUNE JN.'], region: 'MAHARASHTRA' },
    { name: 'WARDHA', dbAliases: ['WR', 'WARDHA'], region: 'MAHARASHTRA' },
    { name: 'CSMT', dbAliases: ['CSMT', 'CST'], region: 'MAHARASHTRA' },
    { name: 'SOLAPUR', dbAliases: ['SUR', 'SOLAPUR'], region: 'MAHARASHTRA' },
    // SOUTH
    { name: 'CHENNAI CENTRAL', dbAliases: ['MAS', 'CHENNAI CENT'], region: 'SOUTH' },
    { name: 'VIJAYAWADA', dbAliases: ['BZA', 'VIJAYAWADA'], region: 'SOUTH' },
    { name: 'SECUNDERABAD', dbAliases: ['SC', 'SECUNDERABAD'], region: 'SOUTH' },
    { name: 'BANGALORE', dbAliases: ['SBC', 'BANGALORE'], region: 'SOUTH' },
    { name: 'JOLARPETTAI', dbAliases: ['JTJ', 'JOLARPETTAI'], region: 'SOUTH' },
    { name: 'KATPADI', dbAliases: ['KPD', 'KATPADI'], region: 'SOUTH' },
    { name: 'GUNTAKAL', dbAliases: ['GTL', 'GUNTAKAL'], region: 'SOUTH' },
    { name: 'RENIGUNTA', dbAliases: ['RU', 'RENIGUNTA'], region: 'SOUTH' },
    { name: 'GUDUR', dbAliases: ['GDR', 'GUDUR'], region: 'SOUTH' },
    { name: 'YESVANTPUR', dbAliases: ['YPR', 'YESVANTPUR'], region: 'SOUTH' },
    { name: 'HUBLI', dbAliases: ['UBL', 'HUBLI'], region: 'SOUTH' },
    { name: 'GADAG', dbAliases: ['GDG', 'GADAG'], region: 'SOUTH' },
    // WEST
    { name: 'AHMEDABAD', dbAliases: ['ADI', 'AHMEDABAD'], region: 'WEST' },
    { name: 'VADODARA', dbAliases: ['BRC', 'VADODARA'], region: 'WEST' },
    { name: 'SURAT', dbAliases: ['ST', 'SURAT'], region: 'WEST' },
    { name: 'RATLAM', dbAliases: ['RTM', 'RATLAM'], region: 'WEST' },
    { name: 'KOTA', dbAliases: ['KOTA', 'KOTA JN.'], region: 'WEST' },
    { name: 'JAIPUR', dbAliases: ['JP', 'JAIPUR'], region: 'WEST' },
    { name: 'RAJKOT', dbAliases: ['RJT', 'RAJKOT'], region: 'WEST' },
    // EAST
    { name: 'HOWRAH', dbAliases: ['HWH', 'HOWRAH'], region: 'EAST' },
    { name: 'KHARAGPUR', dbAliases: ['KGP', 'KHARAGPUR'], region: 'EAST' },
    { name: 'PATNA', dbAliases: ['PNBE', 'PATNA'], region: 'EAST' },
    { name: 'MUGHALSARAI', dbAliases: ['DDU', 'MGS', 'MUGHALSARAI'], region: 'EAST' },
    { name: 'ASANSOL', dbAliases: ['ASN', 'ASANSOL'], region: 'EAST' },
    { name: 'DHANBAD', dbAliases: ['DHN', 'DHANBAD'], region: 'EAST' },
    { name: 'SEALDAH', dbAliases: ['SDAH', 'SEALDAH'], region: 'EAST' },
    { name: 'GAYA', dbAliases: ['GAYA', 'GAYA JN.'], region: 'EAST' },
    { name: 'VARANASI', dbAliases: ['BSB', 'BSBS', 'DDU'], region: 'EAST' },
    { name: 'KOLHAPUR', dbAliases: ['KOP', 'KOLHAPUR'], region: 'MAHARASHTRA' },
    { name: 'MYSORE', dbAliases: ['MYS', 'MYSORE'], region: 'SOUTH' },
    { name: 'MANGALORE', dbAliases: ['MAQ', 'MAJN'], region: 'SOUTH' }
];
