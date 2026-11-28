// Builds data/syllabus-class8-science.json from the compact lists below.
// Source: NCERT "Curiosity", Science textbook for Grade 8 (2025-26, reprint 2026-27).
// Concepts follow each chapter's section headings and its "Snapshots" summary.
// Definitions are short paraphrases written for this app. They have not been checked by a teacher.
// Run: node tools/build-syllabus.js

const fs = require('fs');
const path = require('path');

const CHAPTERS = {
  1: 'Exploring the Investigative World of Science',
  2: 'The Invisible Living World: Beyond Our Naked Eye',
  3: 'Health: The Ultimate Treasure',
  4: 'Electricity: Magnetic and Heating Effects',
  5: 'Exploring Forces',
  6: 'Pressure, Winds, Storms, and Cyclones',
  7: 'Particulate Nature of Matter',
  8: 'Nature of Matter: Elements, Compounds, and Mixtures',
  9: 'The Amazing World of Solutes, Solvents, and Solutions',
  10: 'Light: Mirrors and Lenses',
  11: 'Keeping Time with the Skies',
  12: 'How Nature Works in Harmony',
  13: 'Our Home: Earth, a Unique Life Sustaining Planet',
};

// [chapter, name, definition, key terms, follow-up question]
const ROWS = [
  [1, 'Scientific investigation', 'Science starts with a question. We make a guess, test it with an experiment, observe carefully, and then decide what the result means.', 'question,experiment,observe', 'Why is one experiment not enough to be sure?'],

  [2, 'Cytoplasm', 'Cytoplasm is the jelly-like material that fills the cell, between the cell membrane and the nucleus. The other parts of the cell sit in it.', 'cytoplasm,fills,cell', 'Where in the cell would you find the cytoplasm?'],
  [2, 'Cell wall', 'Plant, fungal and bacterial cells have an extra outer covering around the cell membrane, called the cell wall. Animal cells do not have it.', 'cell wall,plant,covering', 'Does an animal cell have a cell wall?'],
  [2, 'Shape and size of cells', 'Cells come in different shapes and sizes. The shape of a cell is related to the job it does, such as a long nerve cell that carries messages.', 'shape,size,function', 'Why is a nerve cell long and thin?'],
  [2, 'Levels of organisation', 'Cells that do the same job form a tissue. Tissues form organs, organs form organ systems, and organ systems form the organism.', 'tissue,organ,organism', 'What comes between a cell and an organ?'],
  [2, 'Microorganisms', 'Microorganisms are living things too small to see with the unaided eye. They live everywhere, even inside plants and animals.', 'microorganisms,small,microscope', 'How can we see a microorganism?'],
  [2, 'Unicellular and multicellular organisms', 'A unicellular organism is made of one cell, like bacteria and protozoans. A multicellular organism, like a plant or an animal, is made of many cells.', 'unicellular,multicellular,one cell', 'Is a bacterium unicellular or multicellular?'],
  [2, 'Kinds of microorganisms', 'Bacteria, fungi and protozoa are different kinds of microorganisms. Bacteria do not have a well-defined nucleus.', 'bacteria,fungi,protozoa', 'Which of these lacks a well-defined nucleus?'],
  [2, 'Viruses', 'Viruses are very small, but they are different from other microorganisms because they can reproduce only inside a host organism.', 'virus,host,reproduce', 'Can a virus multiply outside a living body?'],
  [2, 'Microbes that clean the environment', 'Some microorganisms break down dead plants and animal waste into simple substances. This cleans the environment and returns nutrients to the soil.', 'decompose,waste,nutrients', 'What would happen to fallen leaves without these microbes?'],
  [2, 'Nitrogen-fixing bacteria', 'Some bacteria live in the root nodules of legumes such as peas and beans. They trap nitrogen from the air and make the soil more fertile.', 'nitrogen,root nodules,legumes', 'Why do farmers grow beans to improve the soil?'],
  [2, 'Microorganisms and food', 'Yeast, a fungus, makes bread and idli batter rise. Lactobacillus bacteria turn milk into curd. This process is called fermentation.', 'yeast,lactobacillus,fermentation', 'Which microbe turns milk into curd?'],
  [2, 'Microalgae', 'Microalgae are tiny plant-like organisms in water. They make food using sunlight and release oxygen, and they are food for water animals.', 'microalgae,oxygen,water', 'How do microalgae help animals in a pond?'],
  [2, 'Cell as the basic unit of life', 'The cell is called the basic unit of life because every living thing is made of cells, and each cell can carry out the activities needed for life.', 'basic unit,cells,life', 'Why do we call the cell the basic unit of life?'],

  [3, 'Health', 'Health is complete physical, mental and social well-being. It is more than not being sick.', 'physical,mental,social', 'Can a person with no disease still be unhealthy?'],
  [3, 'Healthy lifestyle', 'We stay healthy by eating balanced food, exercising, sleeping well, keeping clean, and keeping our surroundings clean.', 'food,exercise,clean', 'Name two daily habits that keep you healthy.'],
  [3, 'Disease', 'A disease is a condition that affects the normal working of the body or the mind.', 'disease,body,mind', 'How is a disease different from feeling tired after play?'],
  [3, 'Symptoms and signs', 'Symptoms are what the sick person feels, like pain or tiredness. Signs are what others can see or measure, like fever or a rash.', 'symptoms,signs,fever', 'Is a headache a symptom or a sign?'],
  [3, 'Communicable diseases', 'Communicable or infectious diseases are caused by pathogens such as bacteria, viruses and worms. They spread from one person to another through air, water, food, contact or insects.', 'pathogens,spread,infectious', 'How can a cold pass from one person to another?'],
  [3, 'Non-communicable diseases', 'Non-communicable diseases, like diabetes and heart disease, are not caused by germs and do not spread. They come from lifestyle and environment, and healthy habits can often prevent them.', 'diabetes,lifestyle,not spread', 'Can you catch diabetes from a friend?'],
  [3, 'Immune system', 'The immune system is the body\'s own defence. It protects us from harmful pathogens.', 'immune,protect,pathogens', 'What does the immune system fight against?'],
  [3, 'Vaccines', 'A vaccine trains the immune system using dead, weakened or harmless parts of a germ. The body then fights the real germ faster and prevents the disease.', 'vaccine,immune,prevent', 'Why is a vaccine given before a person falls sick?'],
  [3, 'Diagnosis and treatment', 'Diagnosis means finding out which disease a person has. Treatment, such as the right medicine from a doctor, manages or cures it.', 'diagnosis,treatment,medicine', 'Why should we not take antibiotics without a doctor?'],

  [4, 'Magnetic effect of electric current', 'When electric current flows through a wire, it produces a magnetic field around the wire. A compass needle kept near it moves.', 'current,magnetic field,wire', 'What happens to a compass needle near a current-carrying wire?'],
  [4, 'Electromagnet', 'A coil that carries current and behaves like a magnet is called an electromagnet. An iron core inside the coil makes it stronger, and it stops being a magnet when the current stops.', 'coil,current,iron core', 'How can you make an electromagnet stronger?'],
  [4, 'Heating effect of electric current', 'A wire becomes hot when current flows through it. This is the heating effect of electric current, used in heaters, irons and electric kettles.', 'heat,current,wire', 'Name one appliance that uses the heating effect.'],
  [4, 'Electric cell and battery', 'A cell is a device that produces electric current from chemical reactions inside it. A battery is two or more cells joined together.', 'cell,chemical reactions,battery', 'Where does the electricity in a cell come from?'],
  [4, 'Voltaic cell', 'A voltaic cell has two different metal plates dipped in a liquid called an electrolyte. Chemical reactions between them produce electric current.', 'two metals,electrolyte,current', 'What are the three parts of a voltaic cell?'],
  [4, 'Dry cell', 'A dry cell uses a moist paste instead of a liquid, so it does not spill. It cannot be recharged once it is used up.', 'dry cell,paste,single use', 'Why is a dry cell easier to carry than a voltaic cell?'],
  [4, 'Rechargeable batteries', 'A rechargeable battery can be charged again with electricity and used many times, like the battery in a mobile phone.', 'rechargeable,reuse,charge', 'Why are rechargeable batteries better for the environment?'],

  [5, 'Force', 'A force is a push or a pull on an object. It comes from the interaction of that object with another object.', 'push,pull,interaction', 'Give one example of a push and one of a pull.'],
  [5, 'Unit of force', 'The SI unit of force is the newton. Its symbol is N.', 'newton,N,unit', 'What is the symbol for the unit of force?'],
  [5, 'Effects of force', 'A force can change the speed of an object, the direction of its motion, or both. It can also change the shape of an object.', 'speed,direction,shape', 'What does a force do when you squeeze a rubber ball?'],
  [5, 'Force as an interaction', 'A force acts only when two objects interact. One object alone cannot have a force on it.', 'two objects,interaction,force', 'When you push a wall, what are the two objects?'],
  [5, 'Contact forces', 'Contact forces act only when objects touch each other. Muscular force and friction are contact forces.', 'contact,muscular,touch', 'Is lifting a school bag a contact force?'],
  [5, 'Friction', 'Friction is the force that acts when an object moves or tries to move over a surface. It acts opposite to the direction of motion.', 'friction,surface,opposite', 'Why does a rolling ball stop on its own?'],
  [5, 'Non-contact forces', 'Non-contact forces act without touching. Magnetic force, electrostatic force and gravitational force are non-contact forces.', 'non-contact,magnetic,gravitational', 'Name one force that works without touching.'],
  [5, 'Magnetic force', 'Magnetic force is the force a magnet exerts on another magnet or on a magnetic material like iron. It can attract or repel.', 'magnet,attract,repel', 'What happens when two like poles are brought close?'],
  [5, 'Electrostatic force', 'Electrostatic force is the force a charged body exerts on another charged or uncharged body, like a rubbed comb pulling bits of paper.', 'charged,electrostatic,attract', 'Why does a rubbed comb pick up paper pieces?'],
  [5, 'Gravitational force', 'Gravitational force is the force with which the Earth attracts objects towards itself. It is always an attractive force.', 'earth,attracts,gravitational', 'Why does a fruit fall down and not up?'],
  [5, 'Weight', 'Weight is the force with which the Earth pulls an object towards itself. Its SI unit is the newton, and it is measured with a spring balance.', 'weight,earth pulls,newton', 'What instrument measures weight?'],
  [5, 'Mass and weight', 'Mass is the amount of matter in an object and stays the same everywhere. Weight can change from place to place.', 'mass,same,weight changes', 'Would your mass change on the Moon?'],
  [5, 'Buoyant force', 'When an object is placed in a liquid, the liquid pushes it upward. This upward force is called upthrust or buoyant force, and it decides whether the object floats or sinks.', 'upward,upthrust,liquid', 'Why does a bucket feel lighter inside water?'],

  [6, 'Pressure', 'Pressure is the force acting on a unit area. The same force gives more pressure on a smaller area.', 'force,area,pressure', 'Why does a sharp knife cut better than a blunt one?'],
  [6, 'Unit of pressure', 'The SI unit of pressure is newton per square metre. It is also called the pascal, written Pa.', 'pascal,newton per square metre,Pa', 'What is another name for newton per square metre?'],
  [6, 'Pressure in liquids and gases', 'Liquids and gases exert pressure on the walls of their container. The pressure of a liquid increases with depth.', 'liquids,gases,walls', 'Why does water come out faster from a hole near the bottom of a bottle?'],
  [6, 'Atmospheric pressure', 'The air around us has weight and presses on everything. This pressure of the air is called atmospheric pressure.', 'air,atmospheric,pressure', 'Why are we not crushed by atmospheric pressure?'],
  [6, 'Formation of wind', 'Warm air rises and leaves a low-pressure area. Cooler air from a high-pressure area moves in to take its place. This moving air is wind.', 'warm air rises,low pressure,wind', 'In which direction does wind blow: high to low pressure, or low to high?'],
  [6, 'High-speed winds and low pressure', 'Fast-moving air has lower pressure. That is why strong winds can lift roofs: the pressure above the roof drops.', 'high speed,low pressure,roof', 'Why can a strong wind blow a roof upward?'],
  [6, 'Thunderstorms', 'Thunderstorms need moisture and strong winds. Winds moving up and down rub ice particles and water droplets together, and electric charges build up in the clouds.', 'moisture,strong winds,charges', 'What two things are needed for a thunderstorm?'],
  [6, 'Lightning', 'Lightning is a giant electric spark. It happens when charges meet inside a cloud, between clouds, or between a cloud and the ground.', 'charges,cloud,spark', 'Where should you not stand during lightning?'],
  [6, 'Lightning conductor', 'A lightning conductor is a metal rod on a building, joined to the ground. It carries the charge safely into the earth and protects the building.', 'metal rod,ground,protects', 'How does a lightning conductor protect a building?'],
  [6, 'Cyclones', 'A cyclone is a huge storm with very fast winds spinning around a low-pressure centre, formed over warm seas. The India Meteorological Department tracks cyclones and gives warnings.', 'cyclone,low pressure,warning', 'Which department warns us about cyclones in India?'],

  [7, 'Matter is made of particles', 'All matter is made of extremely small particles, far too small to see.', 'matter,particles,small', 'What is everything around us made of?'],
  [7, 'Interparticle attraction', 'Particles of matter attract each other. This force is strongest in solids, weaker in liquids, and weakest in gases.', 'attraction,strongest in solids,weakest in gases', 'In which state do particles attract each other the most?'],
  [7, 'Solid state', 'In a solid, particles are packed closely, attract strongly and cannot move freely. So a solid has a fixed shape and a fixed volume.', 'fixed shape,close,strong attraction', 'Why does a stone keep its shape?'],
  [7, 'Liquid state', 'In a liquid, particles attract a little less and can move past each other. So a liquid has a fixed volume but takes the shape of its container.', 'fixed volume,no fixed shape,move', 'Why does water take the shape of a glass?'],
  [7, 'Gaseous state', 'In a gas, attraction between particles is negligible and they move freely with large spaces between them. So a gas has no fixed shape and no fixed volume.', 'no fixed shape,free,large space', 'Why does a gas fill the whole room?'],
  [7, 'Interparticle spacing and change of state', 'Heating gives particles more energy, so they move apart and the spacing increases. This is how a solid melts into a liquid and a liquid turns into a gas.', 'heating,spacing,change of state', 'What happens to the particles when ice melts?'],
  [7, 'Movement of particles', 'Particles vibrate in place in solids, slide past each other in liquids, and move freely in all directions in gases.', 'vibrate,slide,move freely', 'How do particles move in a solid?'],

  [8, 'Mixture', 'A mixture has two or more substances mixed together. Each substance keeps its own properties, and they do not react chemically.', 'two or more,keep properties,no reaction', 'Is salt water a mixture? Why?'],
  [8, 'Components of a mixture', 'The individual substances that make up a mixture are called its components.', 'components,substances,mixture', 'What are the components of lemonade?'],
  [8, 'Air as a mixture', 'Air is a mixture of gases, mainly nitrogen and oxygen, with small amounts of carbon dioxide, water vapour and other gases.', 'air,nitrogen,oxygen', 'Which gas is present in the largest amount in air?'],
  [8, 'Types of mixtures', 'In a uniform mixture the components are spread evenly and cannot be seen separately, like sugar in water. In a non-uniform mixture they can be seen separately, like sand in water.', 'uniform,non-uniform,evenly', 'Is sand in water uniform or non-uniform?'],
  [8, 'Pure substance', 'A pure substance is made of only one type of particle, and all its particles behave in the same way.', 'pure,same type,particles', 'Is tap water a pure substance?'],
  [8, 'Element', 'An element is the simplest substance. It cannot be broken down into simpler substances. Elements are the building blocks of all matter.', 'element,simplest,cannot be broken', 'Name one element you know.'],
  [8, 'Compound', 'A compound is made of two or more elements joined chemically in a fixed ratio. Its properties are different from the elements in it, like water made from hydrogen and oxygen.', 'two or more elements,fixed ratio,different properties', 'How is a compound different from a mixture?'],
  [8, 'Uses of elements, compounds and mixtures', 'We use elements like iron and copper, compounds like water and salt, and mixtures like air and steel every day. Choosing the right one depends on its properties.', 'uses,properties,everyday', 'Give one everyday use of a mixture.'],
  [8, 'Minerals', 'Minerals are natural, solid substances found on the Earth with a fixed chemical composition. Most are compounds, and a few are pure elements.', 'natural,solid,fixed composition', 'Are most minerals elements or compounds?'],

  [9, 'Solution', 'A solution forms when two or more substances mix to make a uniform mixture, like sugar dissolved in water.', 'uniform mixture,dissolve,solution', 'Is muddy water a solution?'],
  [9, 'Solute and solvent', 'When a solid dissolves in a liquid, the solid is the solute and the liquid is the solvent. When two liquids mix, the one in the smaller amount is the solute.', 'solute,solvent,dissolves', 'In salt water, which is the solute?'],
  [9, 'Saturated solution', 'A saturated solution has the maximum amount of solute dissolved in it. No more solute can dissolve at that temperature.', 'saturated,maximum,no more', 'What happens if you add more sugar to a saturated solution?'],
  [9, 'Unsaturated solution', 'An unsaturated solution can still dissolve more solute at that temperature.', 'unsaturated,more solute,dissolve', 'How can you tell a solution is unsaturated?'],
  [9, 'Solubility', 'Solubility is the maximum amount of solute that can dissolve in a fixed quantity, 100 mL, of solvent at a particular temperature.', 'maximum amount,100 mL,temperature', 'Why must we state the temperature for solubility?'],
  [9, 'Temperature and solubility of solids', 'In liquids, the solubility of most solids increases when the temperature rises. More sugar dissolves in hot water than in cold water.', 'temperature,increases,solids', 'Does more sugar dissolve in hot or cold water?'],
  [9, 'Solubility of gases', 'Gases also dissolve in water, like the oxygen fish breathe. The solubility of gases decreases when the temperature rises.', 'gases,decreases,temperature', 'Why does warm water hold less oxygen for fish?'],
  [9, 'Mass and volume', 'Mass is the amount of matter in an object, measured with a weighing balance. Volume is the space it occupies, measured with a measuring cylinder.', 'mass,volume,space', 'Which device measures the volume of a liquid?'],
  [9, 'Density', 'Density is the mass per unit volume of a substance. Density equals mass divided by volume.', 'mass,volume,divided', 'What is the formula for density?'],
  [9, 'Floating and sinking', 'An object less dense than water floats on it. An object denser than water sinks.', 'less dense,floats,sinks', 'Why does oil float on water?'],
  [9, 'Temperature, pressure and density', 'Density generally decreases when temperature rises, because substances expand. Pressure changes the density of gases a lot, but liquids and solids very little.', 'temperature,decreases,pressure', 'Why does hot air rise?'],

  [10, 'Spherical mirrors', 'A spherical mirror has a curved reflecting surface. A concave mirror curves inward like the inside of a spoon. A convex mirror bulges outward like the back of a spoon.', 'curved,concave,convex', 'Which side of a spoon is like a concave mirror?'],
  [10, 'Image in a concave mirror', 'The image in a concave mirror can be enlarged, diminished or the same size, and erect or inverted. It depends on how far the object is from the mirror.', 'enlarged,inverted,distance', 'When does a concave mirror show an enlarged, erect image?'],
  [10, 'Image in a convex mirror', 'The image in a convex mirror is always erect and smaller than the object. It shows a wide area, so it is used as a rear-view mirror.', 'erect,diminished,rear-view', 'Why do vehicles use convex mirrors?'],
  [10, 'Laws of reflection', 'First, the angle of incidence equals the angle of reflection. Second, the incident ray, the normal and the reflected ray all lie in the same plane. These laws hold for all mirrors.', 'angle of incidence,angle of reflection,same plane', 'If the angle of incidence is 30 degrees, what is the angle of reflection?'],
  [10, 'Converging and diverging mirrors', 'A concave mirror converges light: it brings the rays together. A convex mirror diverges light: it spreads the rays apart.', 'concave converges,convex diverges,rays', 'Which mirror can focus sunlight to a point?'],
  [10, 'Lenses', 'A lens is a piece of transparent material with curved surfaces. A convex lens is thicker in the middle. A concave lens is thinner in the middle.', 'transparent,convex,concave', 'Which lens is thicker in the middle?'],
  [10, 'Image by a convex lens', 'A convex lens converges light. Its image can be enlarged, diminished or the same size, and erect or inverted, depending on the distance of the object.', 'converges,enlarged,inverted', 'Which lens is used as a magnifying glass?'],
  [10, 'Image by a concave lens', 'A concave lens diverges light. Its image is always erect and smaller than the object.', 'diverges,erect,diminished', 'Can a concave lens give an enlarged image?'],

  [11, 'Phases of the Moon', 'The bright part of the Moon that we see changes shape from day to day. These shapes, like new Moon, crescent and full Moon, are called phases.', 'phases,new moon,full moon', 'Name two phases of the Moon.'],
  [11, 'Why the Moon has phases', 'Half of the Moon is always lit by the Sun. As the Moon moves around the Earth, we see different parts of its lit half, so its shape seems to change.', 'sun lights,moves around earth,different parts', 'Does the Moon make its own light?'],
  [11, 'The Moon\'s monthly cycle', 'One full cycle of the phases of the Moon takes about a month.', 'cycle,about a month,phases', 'About how long from one full Moon to the next?'],
  [11, 'How calendars began', 'People noticed cycles in nature: day and night, the phases of the Moon, and the seasons. They used these cycles to make calendars.', 'cycles,calendar,seasons', 'Which natural cycle gives us a month?'],
  [11, 'Lunar calendar', 'A lunar calendar follows the cycle of the Moon. Its months follow the phases of the Moon.', 'lunar,moon,months', 'What does a lunar calendar follow?'],
  [11, 'Solar calendar', 'A solar calendar follows the cycle of the seasons, which depends on the position of the Earth in its orbit around the Sun.', 'solar,seasons,sun', 'What does a solar calendar follow?'],
  [11, 'Luni-solar calendar', 'A luni-solar calendar follows both the Moon and the seasons. It adds an extra month from time to time to stay in step with the seasons.', 'both,extra month,moon and sun', 'Why does a luni-solar calendar add an extra month?'],
  [11, 'Indian National Calendar', 'The Indian National Calendar is a solar calendar used officially in India along with the Gregorian calendar. Its year begins with the month of Chaitra.', 'national calendar,solar,chaitra', 'Which month begins the Indian National Calendar?'],
  [11, 'Festivals and astronomy', 'Many festivals are fixed by the position of the Moon or the Sun. That is why some festivals fall on different dates each year.', 'festivals,moon,dates change', 'Why does Diwali fall on a different date each year?'],
  [11, 'Artificial satellites', 'Artificial satellites are human-made objects launched from the Earth to orbit it. They help with communication, weather forecasting, navigation and the study of space.', 'human-made,orbit,communication', 'Give one use of an artificial satellite.'],

  [12, 'Habitat', 'A habitat is a place that gives an organism the right conditions to live and grow.', 'habitat,place,live', 'What is the habitat of a fish?'],
  [12, 'Biotic and abiotic components', 'Biotic components are the living parts of a habitat: plants, animals and microbes. Abiotic components are the non-living parts: air, water, soil and temperature.', 'biotic,abiotic,living', 'Is soil biotic or abiotic?'],
  [12, 'Population and community', 'All organisms of one kind living in an area form a population. All the different populations living together in that area form a community.', 'population,community,together', 'Do all organisms in a community play the same role?'],
  [12, 'Ecosystem', 'An ecosystem is formed by the interaction between the living and non-living components of an area.', 'ecosystem,interaction,living and non-living', 'What two kinds of components make an ecosystem?'],
  [12, 'Types of ecosystems', 'Ecosystems can be terrestrial, on land, such as forests, grasslands and deserts. They can be aquatic, in water, such as ponds, lakes and oceans.', 'terrestrial,aquatic,forest', 'Is a pond a terrestrial or an aquatic ecosystem?'],
  [12, 'Producers, consumers and decomposers', 'Producers, like plants, make their own food. Consumers eat plants or animals. Decomposers, like bacteria and fungi, break down dead matter.', 'producers,consumers,decomposers', 'Is a mushroom a producer or a decomposer?'],
  [12, 'Food chain and food web', 'A food chain shows who eats whom in an ecosystem. A food web shows how many food chains are connected.', 'food chain,food web,who eats whom', 'Make a food chain with grass, a deer and a tiger.'],
  [12, 'Trophic levels', 'The position of an organism in a food chain is called its trophic level. Producers are the first level.', 'trophic level,position,food chain', 'At which trophic level are plants?'],
  [12, 'Mutualism, commensalism and parasitism', 'In mutualism both organisms benefit. In commensalism one benefits and the other is not affected. In parasitism one benefits and the other is harmed.', 'mutualism,commensalism,parasitism', 'A tick on a dog: which relationship is this?'],
  [12, 'Waste in nature', 'Decomposers break down dead plants, animals and waste, and recycle the nutrients back into the soil. Nothing is wasted in nature.', 'decomposers,recycle,nutrients', 'What would a forest floor look like without decomposers?'],
  [12, 'Balance in an ecosystem', 'A change in one part of an ecosystem affects the other parts. The interactions between organisms keep the ecosystem in balance.', 'balance,change,affects', 'What may happen to deer if all tigers disappear?'],
  [12, 'Benefits of ecosystems', 'Ecosystems give us clean air, water, food and medicine, and help control the climate. Human-made ecosystems, like farms, depend on healthy natural ones.', 'clean air,food,climate', 'Name two things a forest gives us.'],
  [12, 'Threats and conservation', 'Pollution, deforestation, habitat loss, climate change, invasive species and overuse of resources harm ecosystems. National parks and sanctuaries help protect them.', 'pollution,deforestation,national parks', 'How does a national park protect animals?'],

  [13, 'Earth as a unique planet', 'The Earth is the only planet in the solar system known to support life. Other planets are too hot, too cold, or lack liquid water and a suitable atmosphere.', 'earth,life,liquid water', 'Why is there no life on Mercury?'],
  [13, 'Habitable zone', 'The Earth orbits the Sun at a distance where it is neither too hot nor too cold, so water stays liquid. This region is called the habitable zone or Goldilocks zone.', 'habitable zone,distance,liquid water', 'What is another name for the habitable zone?'],
  [13, 'Earth\'s orbit', 'The Earth moves around the Sun in a nearly circular orbit. So it does not become too hot or too cold at any time of the year.', 'nearly circular,orbit,sun', 'What shape is the Earth\'s orbit?'],
  [13, 'Size and gravity of the Earth', 'The Earth\'s gravity is strong enough to hold its atmosphere, and not so strong that living things are crushed by their own weight.', 'gravity,atmosphere,size', 'What would happen to our air if the Earth had very weak gravity?'],
  [13, 'Ozone layer', 'Ozone in the atmosphere stops harmful ultraviolet rays of the Sun from reaching the surface of the Earth.', 'ozone,ultraviolet,protects', 'Which rays does the ozone layer block?'],
  [13, 'Magnetic field of the Earth', 'The Earth\'s magnetic field shields it from high-energy particles from space that could destroy life.', 'magnetic field,shield,particles', 'What does the Earth\'s magnetic field protect us from?'],
  [13, 'Spheres of the Earth', 'The atmosphere is air, the hydrosphere is water, the geosphere is the solid Earth, and the biosphere is life. They interact and together sustain life.', 'atmosphere,hydrosphere,biosphere', 'Which sphere do rivers and oceans belong to?'],
  [13, 'Reproduction', 'Reproduction is the process by which living things produce young ones of their own kind. It keeps life going on the Earth.', 'reproduction,young ones,continuity', 'Why is reproduction needed for a species?'],
  [13, 'Asexual reproduction', 'In asexual reproduction a single parent produces new individuals that are exact copies of itself.', 'single parent,exact copies,asexual', 'How many parents are needed in asexual reproduction?'],
  [13, 'Sexual reproduction', 'In sexual reproduction two parents are involved, and the young ones can show new features that differ from the parents.', 'two parents,new features,sexual', 'Why do children not look exactly like one parent?'],
  [13, 'Development of the embryo', 'After fertilisation, a zygote forms and develops into an embryo. In some animals this happens inside the mother\'s body, and in others outside, in eggs.', 'zygote,embryo,inside or outside', 'Where does a chick embryo develop?'],
  [13, 'Triple planetary crisis', 'Climate change, loss of biodiversity and pollution together threaten life on the Earth. They are called the triple planetary crisis.', 'climate change,biodiversity loss,pollution', 'Name the three parts of the triple planetary crisis.'],
];

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The three hand-made Cell concepts (with misconceptions) open Chapter 2.
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'class8-science.json'), 'utf8'));

const chapters = Object.entries(CHAPTERS).map(([number, title]) => ({ number: Number(number), title, concepts: [] }));
chapters.find((c) => c.number === 2).concepts.push(...cell.concepts);

for (const [chapter, name, definition, terms, followUp] of ROWS) {
  const keyTerms = terms.split(',').map((t) => t.trim());
  chapters.find((c) => c.number === chapter).concepts.push({
    id: `c${chapter}-${slug(name)}`,
    name,
    definition,
    keyTerms,
    hint: `Think about these words: ${keyTerms.slice(0, 2).join(' and ')}.`,
    followUp,
    misconceptions: [],
  });
}

const out = {
  class: 8,
  subject: 'Science',
  book: 'NCERT Curiosity, Textbook of Science for Grade 8',
  note: 'Concept list follows the section headings and the Snapshots summary of each chapter. Definitions are short paraphrases, not yet checked by a teacher.',
  chapters,
};
fs.writeFileSync(path.join(__dirname, '..', 'data', 'syllabus-class8-science.json'), JSON.stringify(out, null, 1));
console.log(chapters.map((c) => `Ch ${c.number}: ${c.concepts.length}`).join(' | '), '| total', chapters.reduce((s, c) => s + c.concepts.length, 0));
